#!/bin/bash

# Measure how long it takes for a powerbank in a given slot to finish charging.
# Strategy:
#   1) Poll the model `slots` command at a fixed interval.
#   2) Read slots[].isCharging for the user-selected slot index.
#   3) Wait until isCharging becomes true -> start the timer.
#   4) Keep polling until isCharging becomes false -> stop the timer.
#   5) Report the elapsed time.
#
# powerLevel is logged alongside isCharging for observability (it can rise
# above 100% while charging and falls back to 100% once charging finishes).

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
ALLOWED_MODELS=("S1TT30" "S1TT6")
DEFAULT_POLL_INTERVAL_S=5
DEFAULT_TIMEOUT_MIN=240

chmod +x "$EXECUTABLE" 2>/dev/null

read_input() {
    local prompt="$1"
    local var_name="$2"
    read -p "$prompt" "$var_name"
}

# Format seconds as HH:MM:SS
format_duration() {
    local total_seconds="$1"
    printf '%02d:%02d:%02d' \
        $((total_seconds / 3600)) \
        $(((total_seconds % 3600) / 60)) \
        $((total_seconds % 60))
}

# Query the slots command and extract isCharging + powerLevel for the
# target index. Sets globals:
#   LAST_IS_CHARGING ("true" | "false" | "unknown")
#   LAST_POWER_LEVEL (numeric or "n/a")
#   LAST_SLOT_STATE  (e.g. "available", "empty", or "unknown")
LAST_IS_CHARGING="unknown"
LAST_POWER_LEVEL="n/a"
LAST_SLOT_STATE="unknown"
LAST_RAW_OUTPUT=""
read_slot_status() {
    local model="$1"
    local target_index="$2"

    LAST_IS_CHARGING="unknown"
    LAST_POWER_LEVEL="n/a"
    LAST_SLOT_STATE="unknown"

    LAST_RAW_OUTPUT=$("$EXECUTABLE" "$model" slots 2>&1)
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        return
    fi

    if command -v jq &> /dev/null; then
        if echo "$LAST_RAW_OUTPUT" | jq empty 2>/dev/null; then
            local slot_json
            slot_json=$(echo "$LAST_RAW_OUTPUT" | jq -c --argjson idx "$target_index" '.slots[]? | select(.index == $idx)' 2>/dev/null)
            if [ -n "$slot_json" ] && [ "$slot_json" != "null" ]; then
                local val
                # Note: do not use `// empty` here — jq's // treats `false` as
                # absent, which would silently drop the not-yet-charging signal
                # and keep us stuck in Phase 1.
                val=$(echo "$slot_json" | jq -r '.isCharging' 2>/dev/null)
                if [ "$val" = "true" ] || [ "$val" = "false" ]; then
                    LAST_IS_CHARGING="$val"
                fi
                local pl
                pl=$(echo "$slot_json" | jq -r '.powerBank.powerLevel // empty' 2>/dev/null)
                if [ -n "$pl" ]; then
                    LAST_POWER_LEVEL="$pl"
                fi
                local st
                st=$(echo "$slot_json" | jq -r '.state // empty' 2>/dev/null)
                if [ -n "$st" ]; then
                    LAST_SLOT_STATE="$st"
                fi
            fi
            return
        fi
    fi

    # Fallback (no jq or invalid JSON): best-effort grep.
    # We can't reliably scope to a single slot without jq, so this only
    # extracts the first isCharging value as a degraded signal.
    if echo "$LAST_RAW_OUTPUT" | grep -qE '"isCharging"[[:space:]]*:[[:space:]]*true'; then
        LAST_IS_CHARGING="true"
    elif echo "$LAST_RAW_OUTPUT" | grep -qE '"isCharging"[[:space:]]*:[[:space:]]*false'; then
        LAST_IS_CHARGING="false"
    fi
}

# Inputs
echo "Select model:"
echo "  1) S1TT30 (30 slots)"
echo "  2) S1TT6 (6 slots)"
read_input "Enter selection (1 or 2): " model_choice
model_choice=$(echo "$model_choice" | tr -d '[:space:]')
case "$model_choice" in
    1) model="S1TT30"; slot_index_max=30 ;;
    2) model="S1TT6"; slot_index_max=6 ;;
    *) echo "Error: Invalid selection. Must be 1 or 2" >&2; exit 1 ;;
esac

read_input "Enter slot index (1-${slot_index_max}): " index
index=$(echo "$index" | tr -d '[:space:]')
if ! [[ "$index" =~ ^[0-9]+$ ]] || [ "$index" -lt 1 ] || [ "$index" -gt "$slot_index_max" ]; then
    echo "Error: Invalid index. Must be between 1 and $slot_index_max" >&2
    exit 1
fi

read_input "Enter polling interval in seconds (default: ${DEFAULT_POLL_INTERVAL_S}s): " poll_input
poll_input=$(echo "$poll_input" | tr -d '[:space:]')
if [ -z "$poll_input" ]; then
    poll_interval_s=$DEFAULT_POLL_INTERVAL_S
else
    if ! [[ "$poll_input" =~ ^[0-9]+\.?[0-9]*$ ]] || ! awk "BEGIN {exit !($poll_input > 0)}" 2>/dev/null; then
        echo "Error: Invalid poll interval. Must be a positive number" >&2
        exit 1
    fi
    poll_interval_s="$poll_input"
fi

read_input "Enter max wait timeout in minutes (default: ${DEFAULT_TIMEOUT_MIN} min): " timeout_input
timeout_input=$(echo "$timeout_input" | tr -d '[:space:]')
if [ -z "$timeout_input" ]; then
    timeout_min=$DEFAULT_TIMEOUT_MIN
else
    if ! [[ "$timeout_input" =~ ^[0-9]+$ ]] || [ "$timeout_input" -lt 1 ]; then
        echo "Error: Invalid timeout. Must be a positive integer (minutes)" >&2
        exit 1
    fi
    timeout_min="$timeout_input"
fi
timeout_s=$((timeout_min * 60))

# Prepare log file
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$SCRIPT_DIR/measure_charge_time_${model}_slot${index}_${TIMESTAMP}.log"
log() {
    echo "$@" | tee -a "$LOG_FILE"
}

log "Charge-time measurement - $(date)"
log "Model: $model"
log "Slot index: $index"
log "Poll interval: ${poll_interval_s}s"
log "Max wait timeout: ${timeout_min} min"
log ""

# Forward-declared globals for the summary (populated as we progress)
PHASE1_START_EPOCH=""
PHASE1_END_EPOCH=""
CHARGE_START_EPOCH=""
CHARGE_END_EPOCH=""
POLL_COUNT=0
UNKNOWN_COUNT=0
POWER_LEVEL_START="n/a"
POWER_LEVEL_PEAK="n/a"
POWER_LEVEL_END="n/a"

update_power_level_stats() {
    local pl="$1"
    if [ "$pl" = "n/a" ]; then
        return
    fi
    if [ "$POWER_LEVEL_START" = "n/a" ]; then
        POWER_LEVEL_START="$pl"
    fi
    POWER_LEVEL_END="$pl"
    if [ "$POWER_LEVEL_PEAK" = "n/a" ] || awk "BEGIN {exit !($pl > $POWER_LEVEL_PEAK)}" 2>/dev/null; then
        POWER_LEVEL_PEAK="$pl"
    fi
}

print_summary() {
    log ""
    log "=========================================="
    log "Summary"
    log "=========================================="
    log "Total slots polls: $POLL_COUNT"
    log "Polls with unparseable/error output: $UNKNOWN_COUNT"

    if [ -n "$PHASE1_START_EPOCH" ] && [ -n "$PHASE1_END_EPOCH" ]; then
        local wait_s=$((PHASE1_END_EPOCH - PHASE1_START_EPOCH))
        log "Wait until charging started: ${wait_s}s ($(format_duration $wait_s))"
    elif [ -n "$PHASE1_START_EPOCH" ]; then
        local wait_s=$(( $(date +%s) - PHASE1_START_EPOCH ))
        log "Wait until charging started: did not observe isCharging=true (waited ${wait_s}s)"
    fi

    if [ -n "$CHARGE_START_EPOCH" ] && [ -n "$CHARGE_END_EPOCH" ]; then
        local charge_s=$((CHARGE_END_EPOCH - CHARGE_START_EPOCH))
        log "Charge duration (isCharging true->false): ${charge_s}s ($(format_duration $charge_s))"
    elif [ -n "$CHARGE_START_EPOCH" ]; then
        local charge_s=$(( $(date +%s) - CHARGE_START_EPOCH ))
        log "Charge duration: did not observe isCharging=false (elapsed ${charge_s}s)"
    fi

    log "Power level at charge start: ${POWER_LEVEL_START}"
    log "Power level peak during charge: ${POWER_LEVEL_PEAK}"
    log "Power level at charge end: ${POWER_LEVEL_END}"

    log ""
    log "Results written to: $LOG_FILE"
}

# Allow user to abort cleanly; print whatever phase we reached.
trap 'echo ""; log "Interrupted by user."; print_summary; exit 130' INT TERM

# Phase 1: wait for isCharging to become true
log "Phase 1: waiting for isCharging=true on slot $index ..."
PHASE1_START_EPOCH=$(date +%s)
deadline=$((PHASE1_START_EPOCH + timeout_s))

while true; do
    now=$(date +%s)
    if [ $now -ge $deadline ]; then
        log "Timeout reached before isCharging became true."
        print_summary
        exit 1
    fi

    ((POLL_COUNT++))
    read_slot_status "$model" "$index"
    ts=$(date '+%H:%M:%S')

    case "$LAST_IS_CHARGING" in
        true)
            PHASE1_END_EPOCH=$(date +%s)
            CHARGE_START_EPOCH=$PHASE1_END_EPOCH
            wait_s=$((PHASE1_END_EPOCH - PHASE1_START_EPOCH))
            update_power_level_stats "$LAST_POWER_LEVEL"
            log "[$ts] poll #$POLL_COUNT: isCharging=true, powerLevel=$LAST_POWER_LEVEL, state=$LAST_SLOT_STATE (waited ${wait_s}s for charging to begin)"
            break
            ;;
        false)
            log "[$ts] poll #$POLL_COUNT: isCharging=false, powerLevel=$LAST_POWER_LEVEL, state=$LAST_SLOT_STATE (waiting for charging to start)"
            ;;
        unknown)
            ((UNKNOWN_COUNT++))
            log "[$ts] poll #$POLL_COUNT: isCharging=unknown (command error or slot $index not found in response)"
            ;;
    esac

    sleep "$poll_interval_s"
done

# Phase 2: wait for isCharging to become false (timer is running)
log ""
log "Phase 2: timing charge cycle on slot $index (waiting for isCharging=false) ..."

charge_deadline=$((CHARGE_START_EPOCH + timeout_s))

while true; do
    now=$(date +%s)
    if [ $now -ge $charge_deadline ]; then
        log "Timeout reached before isCharging became false."
        print_summary
        exit 1
    fi

    ((POLL_COUNT++))
    read_slot_status "$model" "$index"
    ts=$(date '+%H:%M:%S')
    elapsed=$((now - CHARGE_START_EPOCH))

    case "$LAST_IS_CHARGING" in
        true)
            update_power_level_stats "$LAST_POWER_LEVEL"
            log "[$ts] poll #$POLL_COUNT: isCharging=true, powerLevel=$LAST_POWER_LEVEL (elapsed ${elapsed}s / $(format_duration $elapsed))"
            ;;
        false)
            CHARGE_END_EPOCH=$(date +%s)
            update_power_level_stats "$LAST_POWER_LEVEL"
            charge_s=$((CHARGE_END_EPOCH - CHARGE_START_EPOCH))
            log "[$ts] poll #$POLL_COUNT: isCharging=false, powerLevel=$LAST_POWER_LEVEL (charge cycle complete after ${charge_s}s / $(format_duration $charge_s))"
            break
            ;;
        unknown)
            ((UNKNOWN_COUNT++))
            log "[$ts] poll #$POLL_COUNT: isCharging=unknown (command error or slot $index not found in response, elapsed ${elapsed}s)"
            ;;
    esac

    sleep "$poll_interval_s"
done

print_summary
