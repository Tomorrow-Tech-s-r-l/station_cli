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
DEFAULT_MODEL="S1TT30"
DEFAULT_DELAY_MS=5
# Delay used by the non-interactive (--model) mode: 1 second between unlocks
NON_INTERACTIVE_DELAY_MS=1000

# Make executable if not already
chmod +x "$EXECUTABLE" 2>/dev/null

usage() {
    cat <<EOF
Usage: $(basename "$0") [--model <MODEL>] [options]

Without any argument the script runs interactively (asks for slot range,
repetitions and delay) against the default model $DEFAULT_MODEL.

With --model it runs unattended over the whole slot range of that model,
once per slot, with a ${NON_INTERACTIVE_DELAY_MS}ms delay between unlocks.

Options:
  --model <MODEL>   S1TT30 (1-30), S1TT6 (1-6), S0TT6 (1-6),
                    S0TT12 (1-12), S0TT18 (1-18)
  --start <N>       First slot index (default: $SLOT_INDEX_MINIMUM)
  --end <N>         Last slot index (default: model maximum)
  --times <N>       Unlocks per slot (default: 1)
  --delay <MS>      Delay between unlocks in milliseconds
                    (default: $NON_INTERACTIVE_DELAY_MS)
  --port <PORT>     Serial port (S0TTXX models only; default: auto-detect)
  -h, --help        Show this help

Examples:
  $(basename "$0") --model S1TT30
  $(basename "$0") --model S1TT6
  $(basename "$0") --model S1TT30 --start 5 --end 10 --times 3 --delay 250
EOF
}

# Return the maximum slot index for a given model, or empty if unknown
slot_index_maximum_for_model() {
    case "$1" in
        S1TT30) echo 30 ;;
        S1TT6)  echo 6 ;;
        S0TT6)  echo 6 ;;
        S0TT12) echo 12 ;;
        S0TT18) echo 18 ;;
        *)      echo "" ;;
    esac
}

# Function to read user input
read_input() {
    local prompt="$1"
    local var_name="$2"
    read -p "$prompt" "$var_name"
}

# Function to delay (in milliseconds)
delay_ms() {
    local ms="$1"
    local seconds
    seconds=$(awk "BEGIN {printf \"%.3f\", $ms / 1000.0}")
    python3 -c "import time; time.sleep($ms / 1000.0)" 2>/dev/null || \
    perl -e "select(undef, undef, undef, $ms / 1000.0)" 2>/dev/null || \
    sleep "$seconds"
}

# Validate a slot index against the model range
validate_slot() {
    local label="$1"
    local value="$2"
    if ! [[ "$value" =~ ^[0-9]+$ ]] || \
       [ "$value" -lt "$SLOT_INDEX_MINIMUM" ] || \
       [ "$value" -gt "$SLOT_INDEX_MAXIMUM" ]; then
        echo "Error: Invalid $label slot. Must be between $SLOT_INDEX_MINIMUM and $SLOT_INDEX_MAXIMUM for $model" >&2
        exit 1
    fi
}

# ------------------------------------------------------------------
# Argument parsing
# ------------------------------------------------------------------
model=""
start_slot=""
end_slot=""
times=""
delay_ms_value=""
port=""

while [ $# -gt 0 ]; do
    case "$1" in
        --model)
            model="$2"; shift 2 || true
            ;;
        --model=*)
            model="${1#*=}"; shift
            ;;
        --start)
            start_slot="$2"; shift 2 || true
            ;;
        --start=*)
            start_slot="${1#*=}"; shift
            ;;
        --end)
            end_slot="$2"; shift 2 || true
            ;;
        --end=*)
            end_slot="${1#*=}"; shift
            ;;
        --times)
            times="$2"; shift 2 || true
            ;;
        --times=*)
            times="${1#*=}"; shift
            ;;
        --delay)
            delay_ms_value="$2"; shift 2 || true
            ;;
        --delay=*)
            delay_ms_value="${1#*=}"; shift
            ;;
        --port)
            port="$2"; shift 2 || true
            ;;
        --port=*)
            port="${1#*=}"; shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            echo "" >&2
            usage >&2
            exit 1
            ;;
    esac
done

# Any argument switches the script to non-interactive mode
if [ -n "$model" ] || [ -n "$start_slot" ] || [ -n "$end_slot" ] || \
   [ -n "$times" ] || [ -n "$delay_ms_value" ] || [ -n "$port" ]; then
    interactive=false
else
    interactive=true
fi

# Resolve the model and its slot range
if [ -z "$model" ]; then
    model="$DEFAULT_MODEL"
fi
model=$(echo "$model" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')
SLOT_INDEX_MAXIMUM=$(slot_index_maximum_for_model "$model")
if [ -z "$SLOT_INDEX_MAXIMUM" ]; then
    echo "Error: Unknown model '$model'. Valid models: S1TT30, S1TT6, S0TT6, S0TT12, S0TT18" >&2
    exit 1
fi

# ------------------------------------------------------------------
# Interactive mode: ask for everything the flags did not provide
# ------------------------------------------------------------------
if [ "$interactive" = "true" ]; then
    # Ask for slot range
    read_input "Enter starting slot index ($SLOT_INDEX_MINIMUM-$SLOT_INDEX_MAXIMUM): " start_slot
    start_slot=$(echo "$start_slot" | tr -d '[:space:]')
    validate_slot "starting" "$start_slot"

    read_input "Enter ending slot index ($SLOT_INDEX_MINIMUM-$SLOT_INDEX_MAXIMUM): " end_slot
    end_slot=$(echo "$end_slot" | tr -d '[:space:]')
    validate_slot "ending" "$end_slot"

    # Ask for number of times
    read_input "Enter number of times to unlock each slot: " times
    times=$(echo "$times" | tr -d '[:space:]')

    # Ask for delay (default is 5ms)
    read_input "Enter delay in milliseconds (default: $DEFAULT_DELAY_MS ms): " delay_input
    delay_input=$(echo "$delay_input" | tr -d '[:space:]')
    if [ -z "$delay_input" ]; then
        delay_ms_value=$DEFAULT_DELAY_MS
    else
        delay_ms_value="$delay_input"
    fi
else
    # Non-interactive defaults: whole slot range, once per slot, 1s delay
    [ -z "$start_slot" ] && start_slot="$SLOT_INDEX_MINIMUM"
    [ -z "$end_slot" ] && end_slot="$SLOT_INDEX_MAXIMUM"
    [ -z "$times" ] && times=1
    [ -z "$delay_ms_value" ] && delay_ms_value="$NON_INTERACTIVE_DELAY_MS"

    start_slot=$(echo "$start_slot" | tr -d '[:space:]')
    end_slot=$(echo "$end_slot" | tr -d '[:space:]')
    times=$(echo "$times" | tr -d '[:space:]')
    delay_ms_value=$(echo "$delay_ms_value" | tr -d '[:space:]')

    validate_slot "starting" "$start_slot"
    validate_slot "ending" "$end_slot"
fi

# ------------------------------------------------------------------
# Shared validation
# ------------------------------------------------------------------
# Validate that start <= end
if [ "$start_slot" -gt "$end_slot" ]; then
    echo "Error: Starting slot ($start_slot) must be less than or equal to ending slot ($end_slot)" >&2
    exit 1
fi

# Validate times
if ! [[ "$times" =~ ^[0-9]+$ ]] || [ "$times" -lt 1 ]; then
    echo "Error: Invalid number of times. Must be at least 1" >&2
    exit 1
fi

# Validate delay - must be a positive number (can be decimal)
if ! [[ "$delay_ms_value" =~ ^[0-9]+\.?[0-9]*$ ]]; then
    echo "Error: Invalid delay. Must be a positive number" >&2
    exit 1
fi
# Check if it's greater than 0 using awk (more portable than bc)
if ! awk "BEGIN {exit !($delay_ms_value > 0)}" 2>/dev/null; then
    echo "Error: Invalid delay. Must be greater than 0" >&2
    exit 1
fi

# Serial port is only meaningful on the S0TTXX gateway models
port_args=()
if [ -n "$port" ]; then
    case "$model" in
        S0TT6|S0TT12|S0TT18)
            port_args=(-p "$port")
            ;;
        *)
            echo "Warning: --port is only supported for S0TTXX models; ignoring for $model" >&2
            ;;
    esac
fi

echo ""
echo "Model: $model"
echo "Unlocking slots ($start_slot-$end_slot), $times time(s) per slot with ${delay_ms_value}ms delay between unlocks..."
echo ""

# Initialize counters
total_success_count=0
total_timeout_failure_count=0
first_call=true

# Loop through selected slot range
for ((slot=$start_slot; slot<=$end_slot; slot++)); do
    echo "=========================================="
    echo "Slot $slot"
    echo "=========================================="
    
    # Initialize per-slot counters
    slot_success_count=0
    slot_timeout_failure_count=0
    
    # Execute unlock command multiple times with delay
    for ((i=1; i<=times; i++)); do
        # Delay before every call except the very first one, so the delay
        # also applies when moving from one slot to the next
        if [ "$first_call" = "true" ]; then
            first_call=false
        else
            delay_ms "$delay_ms_value"
        fi

        echo "[$i/$times] Executing unlock command..."
        
        # Execute the command and capture output
        # Format: executable MODEL unlock -i SLOT
        output=$("$EXECUTABLE" "$model" unlock -i "$slot" "${port_args[@]}" 2>&1)
        exit_code=$?
        
        if [ $exit_code -eq 0 ]; then
            echo "Output:"
            echo "$output"
            
            # Check if output contains JSON and parse it
            # Try to parse the output as JSON (it should be valid JSON)
            if command -v jq &> /dev/null; then
                # Try to parse the entire output as JSON
                if echo "$output" | jq empty 2>/dev/null; then
                    # Valid JSON, parse it
                    success=$(echo "$output" | jq -r '.success // false' 2>/dev/null)
                    error_code=$(echo "$output" | jq -r '.error.code // 0' 2>/dev/null)
                    error_message=$(echo "$output" | jq -r '.error.message // ""' 2>/dev/null)
                    
                    if [ "$success" = "true" ]; then
                        ((slot_success_count++))
                        ((total_success_count++))
                    elif [ "$success" = "false" ] && [ "$error_code" = "1" ] && [ "$error_message" = "Device timeout - device not responding" ]; then
                        ((slot_timeout_failure_count++))
                        ((total_timeout_failure_count++))
                    fi
                fi
            else
                # Fallback: use grep to check for patterns (works with single-line or multi-line JSON)
                if echo "$output" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
                    ((slot_success_count++))
                    ((total_success_count++))
                elif echo "$output" | grep -q '"success"[[:space:]]*:[[:space:]]*false' && \
                     echo "$output" | grep -q '"code"[[:space:]]*:[[:space:]]*1' && \
                     echo "$output" | grep -q 'Device timeout - device not responding'; then
                    ((slot_timeout_failure_count++))
                    ((total_timeout_failure_count++))
                fi
            fi
        else
            echo "Error:"
            echo "$output"
        fi
        
        echo "" # Empty line for readability
    done
    
    echo "Slot $slot summary:"
    echo "  Successful: $slot_success_count"
    echo "  Timeout failures: $slot_timeout_failure_count"
    echo ""
done

echo "=========================================="
echo "Unlock complete!"
echo "=========================================="
echo ""
echo "Overall Summary:"
echo "  Model: $model"
echo "  Slots: $start_slot-$end_slot"
echo "  Total successful: $total_success_count"
echo "  Total timeout failures: $total_timeout_failure_count"
