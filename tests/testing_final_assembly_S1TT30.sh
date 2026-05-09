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

# Fixed interrogation settings
SLOT_INDEX_MINIMUM=1
SLOT_INDEX_MAXIMUM=30
TIMES_PER_SLOT=5
DELAY_MS=500

# Make executable if not already
chmod +x "$EXECUTABLE" 2>/dev/null

# Function to delay (in milliseconds)
delay_ms() {
    local ms="$1"
    python3 -c "import time; time.sleep($ms / 1000.0)" 2>/dev/null || \
    perl -e "select(undef, undef, undef, $ms / 1000.0)" 2>/dev/null || \
    sleep 0.5
}

# Return success when the command output represents a successful reply.
is_success_output() {
    local output="$1"

    if command -v jq >/dev/null 2>&1; then
        if printf '%s' "$output" | jq empty >/dev/null 2>&1; then
            local success
            success=$(printf '%s' "$output" | jq -r '.success // false' 2>/dev/null)
            [ "$success" = "true" ]
            return
        fi

        return 1
    fi

    printf '%s' "$output" | grep -q '"success"[[:space:]]*:[[:space:]]*true'
}

print_slot_list() {
    local first=true
    local slot

    if [ $# -eq 0 ]; then
        echo "None"
        return
    fi

    for slot in "$@"; do
        if [ "$first" = "true" ]; then
            printf '%s' "$slot"
            first=false
        else
            printf ', %s' "$slot"
        fi
    done
    printf '\n'
}

echo ""
echo "Interrogating slots ${SLOT_INDEX_MINIMUM}-${SLOT_INDEX_MAXIMUM}, ${TIMES_PER_SLOT} time(s) each with ${DELAY_MS}ms delay..."
echo ""

declare -a slots_with_missed_replies=()
declare -a slots_passed_interrogation=()
declare -a slots_unlocked_successfully=()
declare -a slots_failed_to_unlock=()
total_successful_replies=0
total_missed_replies=0

for ((slot=SLOT_INDEX_MINIMUM; slot<=SLOT_INDEX_MAXIMUM; slot++)); do
    slot_success_count=0
    slot_missed_count=0
    slot_had_missed_reply=false

    echo "=========================================="
    echo "Slot $slot"
    echo "=========================================="

    for ((attempt=1; attempt<=TIMES_PER_SLOT; attempt++)); do
        output=$("$EXECUTABLE" status -i "$slot" 2>&1)
        exit_code=$?

        if [ $exit_code -eq 0 ] && is_success_output "$output"; then
            ((slot_success_count++))
            ((total_successful_replies++))
            echo "[$attempt/$TIMES_PER_SLOT] Reply received"
        else
            ((slot_missed_count++))
            ((total_missed_replies++))
            slot_had_missed_reply=true
            echo "[$attempt/$TIMES_PER_SLOT] No reply"

            if [ -n "$output" ]; then
                printf '%s\n' "$output" | sed 's/^/    /'
            fi
        fi

        if [ $attempt -lt $TIMES_PER_SLOT ]; then
            delay_ms "$DELAY_MS"
        fi
    done

    if [ "$slot_had_missed_reply" = "true" ]; then
        slots_with_missed_replies+=("$slot")
    else
        slots_passed_interrogation+=("$slot")
    fi

    echo "Summary: ${slot_success_count} reply/replies, ${slot_missed_count} missed"
    echo ""
done

total_attempts=$(((SLOT_INDEX_MAXIMUM - SLOT_INDEX_MINIMUM + 1) * TIMES_PER_SLOT))

echo "=========================================="
echo "Unlocking slots that passed interrogation"
echo "=========================================="

if [ ${#slots_passed_interrogation[@]} -eq 0 ]; then
    echo "No slots passed interrogation. Nothing to unlock."
    echo ""
else
    total_slots_to_unlock=${#slots_passed_interrogation[@]}

    for ((i=0; i<total_slots_to_unlock; i++)); do
        slot="${slots_passed_interrogation[$i]}"
        echo "[$((i + 1))/$total_slots_to_unlock] Unlocking slot $slot..."

        output=$("$EXECUTABLE" unlock -i "$slot" 2>&1)
        exit_code=$?

        if [ $exit_code -eq 0 ] && is_success_output "$output"; then
            slots_unlocked_successfully+=("$slot")
            echo "    Unlock successful"
        else
            slots_failed_to_unlock+=("$slot")
            echo "    Unlock failed"

            if [ -n "$output" ]; then
                printf '%s\n' "$output" | sed 's/^/    /'
            fi
        fi

        if [ $i -lt $((total_slots_to_unlock - 1)) ]; then
            delay_ms "$DELAY_MS"
        fi
    done

    echo ""
fi

echo "=========================================="
echo "Interrogation complete!"
echo "=========================================="
echo "Total attempts: $total_attempts"
echo "Successful replies: $total_successful_replies"
echo "Missed replies: $total_missed_replies"
echo ""
echo "Slots that passed all ${TIMES_PER_SLOT} interrogations:"
print_slot_list "${slots_passed_interrogation[@]}"
echo ""
echo "Slots unlocked successfully:"
print_slot_list "${slots_unlocked_successfully[@]}"
echo ""
echo "Slots that passed interrogation but failed to unlock:"
print_slot_list "${slots_failed_to_unlock[@]}"
echo ""
echo "Slot indexes with at least one missed reply:"
print_slot_list "${slots_with_missed_replies[@]}"
