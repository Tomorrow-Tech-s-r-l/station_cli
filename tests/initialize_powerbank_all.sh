#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTABLES_DIR="$SCRIPT_DIR/../executables"

# Try station-cli-macos first, then fallback to station-cli-macos-arm64
if [ -f "$EXECUTABLES_DIR/station-cli-macos" ]; then
    EXECUTABLE="$EXECUTABLES_DIR/station-cli-macos"
elif [ -f "$EXECUTABLES_DIR/station-cli-macos-arm64" ]; then
    EXECUTABLE="$EXECUTABLES_DIR/station-cli-macos-arm64"
else
    echo "Error: Executable not found. Tried:" >&2
    echo "  $EXECUTABLES_DIR/station-cli-macos" >&2
    echo "  $EXECUTABLES_DIR/station-cli-macos-arm64" >&2
    exit 1
fi

# Constants
SLOT_INDEX_MINIMUM=1
SLOT_INDEX_MAXIMUM=30
SERIAL_LENGTH=10

# Defaults for the initialize-powerbank command
DEFAULT_TOTAL_CHARGE=13925
DEFAULT_CURRENT_CHARGE=11625
DEFAULT_CUTOFF_CHARGE=10625
DEFAULT_CYCLES=0
DEFAULT_DELAY_MS=100

# Make executable if not already
chmod +x "$EXECUTABLE" 2>/dev/null

# Function to read user input
read_input() {
    local prompt="$1"
    local var_name="$2"
    read -p "$prompt" "$var_name"
}

# Function to delay (in milliseconds)
delay_ms() {
    local ms="$1"
    python3 -c "import time; time.sleep($ms / 1000.0)" 2>/dev/null || \
    perl -e "select(undef, undef, undef, $ms / 1000.0)" 2>/dev/null || \
    sleep 0.1
}

# Generate a random uppercase-alphanumeric serial of exactly SERIAL_LENGTH chars
generate_serial() {
    LC_ALL=C tr -dc 'A-Z0-9' < /dev/urandom | head -c "$SERIAL_LENGTH"
}

# Read an unsigned-integer value with a default; validates range [0, 65535]
read_uint16_with_default() {
    local label="$1"
    local default_value="$2"
    local out_var="$3"
    local input
    read -p "  Enter $label (default: $default_value): " input
    input=$(echo "$input" | tr -d '[:space:]')
    if [ -z "$input" ]; then
        eval "$out_var=$default_value"
        return 0
    fi
    if ! [[ "$input" =~ ^[0-9]+$ ]] || [ "$input" -lt 0 ] || [ "$input" -gt 65535 ]; then
        echo "Error: Invalid $label. Must be an integer between 0 and 65535" >&2
        exit 1
    fi
    eval "$out_var=$input"
}

echo "=========================================="
echo "Initialize powerbanks"
echo "=========================================="
echo ""
echo "Each slot will receive a unique random ${SERIAL_LENGTH}-character uppercase-alphanumeric serial number."
echo "Slot range can be customized below (defaults: ${SLOT_INDEX_MINIMUM}-${SLOT_INDEX_MAXIMUM})."
echo ""
echo "Press ENTER on any of the following prompts to keep the default value."
echo ""

# Ask for slot range (defaults: full 1..30 range)
read_input "  Enter start slot (default: $SLOT_INDEX_MINIMUM): " start_input
start_input=$(echo "$start_input" | tr -d '[:space:]')
if [ -z "$start_input" ]; then
    start_slot=$SLOT_INDEX_MINIMUM
else
    if ! [[ "$start_input" =~ ^[0-9]+$ ]] || [ "$start_input" -lt "$SLOT_INDEX_MINIMUM" ] || [ "$start_input" -gt "$SLOT_INDEX_MAXIMUM" ]; then
        echo "Error: Invalid start slot. Must be between $SLOT_INDEX_MINIMUM and $SLOT_INDEX_MAXIMUM" >&2
        exit 1
    fi
    start_slot="$start_input"
fi

read_input "  Enter end slot   (default: $SLOT_INDEX_MAXIMUM): " end_input
end_input=$(echo "$end_input" | tr -d '[:space:]')
if [ -z "$end_input" ]; then
    end_slot=$SLOT_INDEX_MAXIMUM
else
    if ! [[ "$end_input" =~ ^[0-9]+$ ]] || [ "$end_input" -lt "$SLOT_INDEX_MINIMUM" ] || [ "$end_input" -gt "$SLOT_INDEX_MAXIMUM" ]; then
        echo "Error: Invalid end slot. Must be between $SLOT_INDEX_MINIMUM and $SLOT_INDEX_MAXIMUM" >&2
        exit 1
    fi
    end_slot="$end_input"
fi

if [ "$start_slot" -gt "$end_slot" ]; then
    echo "Error: start slot ($start_slot) must be <= end slot ($end_slot)" >&2
    exit 1
fi

# Ask for battery / cycle values, with defaults applied on empty input
read_uint16_with_default "totalCharge (mAh)"   "$DEFAULT_TOTAL_CHARGE"   total_charge
read_uint16_with_default "currentCharge (mAh)" "$DEFAULT_CURRENT_CHARGE" current_charge
read_uint16_with_default "cutoffCharge (mAh)"  "$DEFAULT_CUTOFF_CHARGE"  cutoff_charge
read_uint16_with_default "cycles"              "$DEFAULT_CYCLES"         cycles

# Sanity check: currentCharge should not exceed totalCharge, cutoff should be <= current
if [ "$current_charge" -gt "$total_charge" ]; then
    echo "Warning: currentCharge ($current_charge) is greater than totalCharge ($total_charge)." >&2
fi
if [ "$cutoff_charge" -gt "$current_charge" ]; then
    echo "Warning: cutoffCharge ($cutoff_charge) is greater than currentCharge ($current_charge)." >&2
fi

# Ask for delay between calls (default DEFAULT_DELAY_MS)
read_input "Enter delay between slots in milliseconds (default: ${DEFAULT_DELAY_MS} ms): " delay_input
delay_input=$(echo "$delay_input" | tr -d '[:space:]')
if [ -z "$delay_input" ]; then
    delay_ms_value=$DEFAULT_DELAY_MS
else
    if ! [[ "$delay_input" =~ ^[0-9]+\.?[0-9]*$ ]]; then
        echo "Error: Invalid delay. Must be a positive number" >&2
        exit 1
    fi
    if ! awk "BEGIN {exit !($delay_input >= 0)}" 2>/dev/null; then
        echo "Error: Invalid delay. Must be >= 0" >&2
        exit 1
    fi
    delay_ms_value="$delay_input"
fi

echo ""
echo "Configuration:"
echo "  slot range:    $start_slot-$end_slot"
echo "  totalCharge:   $total_charge mAh"
echo "  currentCharge: $current_charge mAh"
echo "  cutoffCharge:  $cutoff_charge mAh"
echo "  cycles:        $cycles"
echo "  delay:         ${delay_ms_value} ms"
echo ""

# Prepare timestamped log file (records every slot, its assigned ID, and the result)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$SCRIPT_DIR/initialize_powerbank_all_results_${TIMESTAMP}.log"
ASSIGNMENTS_FILE=$(mktemp -t initialize_powerbank_assignments.XXXXXX)
trap 'rm -f "$ASSIGNMENTS_FILE"' EXIT

success_count=0
failure_count=0
declare -a failed_slots=()

echo "Initializing powerbanks..."
echo ""

for ((slot=start_slot; slot<=end_slot; slot++)); do
    serial=$(generate_serial)

    # Defensive sanity check: serial must be exactly SERIAL_LENGTH chars
    if [ "${#serial}" -ne "$SERIAL_LENGTH" ]; then
        echo "Error: Failed to generate a ${SERIAL_LENGTH}-char serial for slot $slot (got '$serial')" >&2
        ((failure_count++))
        failed_slots+=("$slot")
        echo "$slot|$serial|GENERATION_FAILED" >> "$ASSIGNMENTS_FILE"
        continue
    fi

    echo "[Slot $slot/$end_slot] id=$serial"

    output=$("$EXECUTABLE" initialize-powerbank \
        -i "$slot" \
        --id "$serial" \
        --total-charge "$total_charge" \
        --current-charge "$current_charge" \
        --cutoff-charge "$cutoff_charge" \
        --cycles "$cycles" 2>&1)
    exit_code=$?

    call_success=false
    if [ $exit_code -eq 0 ]; then
        if command -v jq >/dev/null 2>&1; then
            if echo "$output" | jq empty 2>/dev/null; then
                success=$(echo "$output" | jq -r '.success // false' 2>/dev/null)
                [ "$success" = "true" ] && call_success=true
            fi
        else
            if echo "$output" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
                call_success=true
            fi
        fi
    fi

    if [ "$call_success" = "true" ]; then
        echo "  [SUCCESS]"
        ((success_count++))
        echo "$slot|$serial|SUCCESS" >> "$ASSIGNMENTS_FILE"
    else
        echo "  [FAILED] (exit_code=$exit_code)"
        echo "  Output:"
        # Indent the output for readability
        echo "$output" | sed 's/^/    /'
        ((failure_count++))
        failed_slots+=("$slot")
        # Escape pipe characters in output to keep the log file parseable
        sanitized_output=$(echo "$output" | tr '\n' ' ' | tr '|' '/')
        echo "$slot|$serial|FAILED|exit=$exit_code|$sanitized_output" >> "$ASSIGNMENTS_FILE"
    fi

    # Add delay between slots (except after the last one)
    if [ "$slot" -lt "$end_slot" ] && [ -n "$delay_ms_value" ]; then
        if awk "BEGIN {exit !($delay_ms_value > 0)}" 2>/dev/null; then
            delay_ms "$delay_ms_value"
        fi
    fi

    echo ""
done

echo "=========================================="
echo "Initialization complete!"
echo "=========================================="
echo "  Slot range:     $start_slot-$end_slot"
echo "  Total slots:    $((end_slot - start_slot + 1))"
echo "  Successful:     $success_count"
echo "  Failed:         $failure_count"
if [ "${#failed_slots[@]}" -gt 0 ]; then
    echo "  Failed slots:   ${failed_slots[*]}"
fi
echo ""

# Build the persistent log file
{
    echo "Initialize powerbanks - $(date)"
    echo "Executable: $EXECUTABLE"
    echo ""
    echo "Configuration"
    echo "  slot range:    $start_slot-$end_slot"
    echo "  totalCharge:   $total_charge mAh"
    echo "  currentCharge: $current_charge mAh"
    echo "  cutoffCharge:  $cutoff_charge mAh"
    echo "  cycles:        $cycles"
    echo "  delay:         ${delay_ms_value} ms"
    echo ""
    echo "Summary"
    echo "  Slot range:   $start_slot-$end_slot"
    echo "  Total slots:  $((end_slot - start_slot + 1))"
    echo "  Successful:   $success_count"
    echo "  Failed:       $failure_count"
    if [ "${#failed_slots[@]}" -gt 0 ]; then
        echo "  Failed slots: ${failed_slots[*]}"
    fi
    echo ""
    echo "Slot assignments (slot | id | status [| extra])"
    echo "------------------------------------------------"
    awk -F'|' '{
        if (NF <= 3) {
            printf "  Slot %2s: id=%s status=%s\n", $1, $2, $3
        } else {
            extras = $4
            for (i = 5; i <= NF; i++) extras = extras "|" $i
            printf "  Slot %2s: id=%s status=%s (%s)\n", $1, $2, $3, extras
        }
    }' "$ASSIGNMENTS_FILE"
} > "$LOG_FILE"

echo "Results written to: $LOG_FILE"
