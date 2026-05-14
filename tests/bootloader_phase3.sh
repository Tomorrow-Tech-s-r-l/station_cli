#!/bin/bash
#
# Phase 3 bootloader integration test for the P1TT2C powerbank firmware.
#
# Per iteration the script drives the full Phase 3 round-trip:
#
#   1. enter-boot  -i <index>   (app drops into the bootloader)
#   2. fwu-hello   -i <index>   (bootloader returns version + slot info)
#   3. fwu-exit    -i <index>   (bootloader resets back into the app)
#
# Each transition is followed by a short settle delay so the chip can
# finish resetting before the next command goes out on the pogo pin.
#
# A timestamped results log goes next to this script. Mirrors the style of
# tests/interrogate_status.sh so the output can be diffed/compared across
# runs.

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
# 300 ms is plenty for a Cortex-M0 reset + clock re-config + USART1 re-init.
# The app's MX_USART1_UART_Init runs inside ~5 ms post-reset so the
# bootloader / app is ready well before the next CLI frame goes out.
DEFAULT_RESET_DELAY_MS=300
# Phase 3 firmware version we expect FWU_HELLO to report.
EXPECTED_BL_MAJOR=0
EXPECTED_BL_MINOR=1

chmod +x "$EXECUTABLE" 2>/dev/null

read_input() {
    local prompt="$1"
    local var_name="$2"
    read -p "$prompt" "$var_name"
}

sleep_ms() {
    local ms="$1"
    python3 -c "import time; time.sleep($ms / 1000.0)" 2>/dev/null || \
    perl -e "select(undef, undef, undef, $ms / 1000.0)" 2>/dev/null || \
    sleep 0.2
}

# Ask for slot index
read_input "Enter slot index ($SLOT_INDEX_MINIMUM-$SLOT_INDEX_MAXIMUM): " index
index=$(echo "$index" | tr -d '[:space:]')

if ! [[ "$index" =~ ^[0-9]+$ ]] || [ "$index" -lt "$SLOT_INDEX_MINIMUM" ] || [ "$index" -gt "$SLOT_INDEX_MAXIMUM" ]; then
    echo "Error: Invalid index. Must be between $SLOT_INDEX_MINIMUM and $SLOT_INDEX_MAXIMUM" >&2
    exit 1
fi

# Ask for iteration count
read_input "Enter number of full ENTER_BOOT -> FWU_HELLO -> FWU_EXIT cycles: " times
times=$(echo "$times" | tr -d '[:space:]')

if ! [[ "$times" =~ ^[0-9]+$ ]] || [ "$times" -lt 1 ]; then
    echo "Error: Invalid number. Must be at least 1" >&2
    exit 1
fi

# Ask for reset settle delay
read_input "Enter reset settle delay in milliseconds (default: $DEFAULT_RESET_DELAY_MS ms): " delay_input
delay_input=$(echo "$delay_input" | tr -d '[:space:]')

if [ -z "$delay_input" ]; then
    delay_ms=$DEFAULT_RESET_DELAY_MS
else
    if ! [[ "$delay_input" =~ ^[0-9]+$ ]] || [ "$delay_input" -lt 1 ]; then
        echo "Error: Invalid delay. Must be a positive integer in ms" >&2
        exit 1
    fi
    delay_ms="$delay_input"
fi

echo ""
echo "Phase 3 bootloader test"
echo "  slot index: $index   cycles: $times   reset delay: ${delay_ms} ms"
echo ""

enter_ok=0
hello_ok=0
exit_ok=0
hello_app_present_ok=0
cycle_fully_ok=0

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$SCRIPT_DIR/bootloader_phase3_${TIMESTAMP}.log"

run_step() {
    local label="$1"
    local subcommand="$2"
    local idx="$3"
    local output
    output=$("$EXECUTABLE" "$subcommand" -i "$idx" 2>&1)
    local rc=$?
    echo "--- $label (rc=$rc) ---"
    echo "$output"
    echo ""
    # Echo to log via the caller's redirection.
    LAST_OUTPUT="$output"
    LAST_RC=$rc
}

{
    echo "Phase 3 bootloader test - $(date)"
    echo "Executable: $EXECUTABLE"
    echo "Slot index: $index"
    echo "Cycles: $times"
    echo "Reset settle delay: ${delay_ms} ms"
    echo ""

    for ((i=1; i<=times; i++)); do
        echo "=========================================="
        echo "[cycle $i/$times]"
        echo "=========================================="

        # Step 1: ENTER_BOOT - app -> bootloader
        run_step "ENTER_BOOT" "enter-boot" "$index"
        enter_step_ok=false
        if [ "$LAST_RC" -eq 0 ] && command -v jq &> /dev/null \
           && echo "$LAST_OUTPUT" | jq empty 2>/dev/null \
           && [ "$(echo "$LAST_OUTPUT" | jq -r '.success')" = "true" ]; then
            enter_step_ok=true
            ((enter_ok++))
        fi
        sleep_ms "$delay_ms"

        # Step 2: FWU_HELLO - bootloader returns version + slot info
        run_step "FWU_HELLO" "fwu-hello" "$index"
        hello_step_ok=false
        if [ "$LAST_RC" -eq 0 ] && command -v jq &> /dev/null \
           && echo "$LAST_OUTPUT" | jq empty 2>/dev/null \
           && [ "$(echo "$LAST_OUTPUT" | jq -r '.success')" = "true" ]; then
            hello_step_ok=true
            ((hello_ok++))

            bl_major=$(echo "$LAST_OUTPUT" | jq -r '.bootloader.blVersionMajor // empty')
            bl_minor=$(echo "$LAST_OUTPUT" | jq -r '.bootloader.blVersionMinor // empty')
            app_present=$(echo "$LAST_OUTPUT" | jq -r '.bootloader.appPresent // false')
            page_size=$(echo "$LAST_OUTPUT" | jq -r '.bootloader.pageSize // empty')
            slot_size=$(echo "$LAST_OUTPUT" | jq -r '.bootloader.slotSize // empty')

            echo "  parsed: bl=${bl_major}.${bl_minor}  app_present=${app_present}  page=${page_size}  slot=${slot_size}"

            if [ "$bl_major" = "$EXPECTED_BL_MAJOR" ] && [ "$bl_minor" = "$EXPECTED_BL_MINOR" ]; then
                echo "  [OK] BL version matches expected ${EXPECTED_BL_MAJOR}.${EXPECTED_BL_MINOR}"
            else
                echo "  [WARN] BL version mismatch (got ${bl_major}.${bl_minor}, expected ${EXPECTED_BL_MAJOR}.${EXPECTED_BL_MINOR})"
            fi
            if [ "$app_present" = "true" ]; then
                ((hello_app_present_ok++))
                echo "  [OK] appPresent=true"
            else
                echo "  [WARN] appPresent=false (no valid app header at 0x08002000)"
            fi
        fi
        sleep_ms "$delay_ms"

        # Step 3: FWU_EXIT - bootloader -> app
        run_step "FWU_EXIT" "fwu-exit" "$index"
        exit_step_ok=false
        if [ "$LAST_RC" -eq 0 ] && command -v jq &> /dev/null \
           && echo "$LAST_OUTPUT" | jq empty 2>/dev/null \
           && [ "$(echo "$LAST_OUTPUT" | jq -r '.success')" = "true" ]; then
            exit_step_ok=true
            ((exit_ok++))
        fi
        sleep_ms "$delay_ms"

        if $enter_step_ok && $hello_step_ok && $exit_step_ok; then
            ((cycle_fully_ok++))
            echo "[cycle $i] PASS"
        else
            echo "[cycle $i] FAIL (enter=$enter_step_ok hello=$hello_step_ok exit=$exit_step_ok)"
        fi
        echo ""
    done

    echo "=========================================="
    echo "Summary"
    echo "=========================================="
    echo "  Cycles:                $times"
    echo "  ENTER_BOOT success:    $enter_ok"
    echo "  FWU_HELLO success:     $hello_ok"
    echo "    of which appPresent: $hello_app_present_ok"
    echo "  FWU_EXIT success:      $exit_ok"
    echo "  Fully-OK cycles:       $cycle_fully_ok"
} 2>&1 | tee "$LOG_FILE"

echo ""
echo "Results written to: $LOG_FILE"
