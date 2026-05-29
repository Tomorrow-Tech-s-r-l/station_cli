#!/bin/bash
#
# Stress / regression suite for the in-progress firmware fixes
# (bootloader robustness, SOC stability, transaction isolation, etc.).
#
# This script is interactive: many tests need a human to pull power,
# wait on a charge cycle, or move powerbanks between slots. Each
# sub-test logs to its own timestamped file so runs can be diffed.
#
# Menu of sub-tests:
#   1) FWU power-cycle: kill power mid-DATA, then mid-FINISH/CRC  (B-7, B-17/V-29, V-14)
#   2) BL watchdog fallback: enter BL, drop link, verify app resumes (B-2, B-29)
#   3) Back-to-back FWU on same PB                                 (B-13 stale-event poisoning)
#   4) Station FWU power-cycle: kill power mid-DATA / mid-FINISH   (B-7, V-14)
#   5) B-1 divide-by-zero: totalCap == cutoffCap on init           (B-1)
#   6) Charge-cycle SOC monitor (long-running, full discharge→charge) (B-1, B-26, FeNFivk05)
#   7) Self-discharge re-enter CHARGING (long-running)             (B-26)
#   8) Cross-slot transaction isolation                            (B-13, B-36, B-38)
#   9) FW version string length regression                         (V-26 / B-40)
#  10) Run everything that doesn't require power-pull
#
# Tests requiring raw frame injection (sub-5B frames, garbage >
# UART_FRAME_MAX_LEN, malformed FWU reply with next_expected_offset
# = 0xFFFFFFFF) are NOT covered here — the CLI has no raw-send entry
# point, so those go through a dedicated fuzzer.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTABLES_DIR="$SCRIPT_DIR/../executables"

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

SLOT_INDEX_MINIMUM=1
SLOT_INDEX_MAXIMUM=30
BOARD_ADDRESS_MINIMUM=0
BOARD_ADDRESS_MAXIMUM=4
DEFAULT_PB_IMAGE="$SCRIPT_DIR/../../../firmware/P1TT2C-firmware/build/P1TT2C-firmware.bin"
DEFAULT_ST_IMAGE="$SCRIPT_DIR/../../../firmware/station-firmware/build/zephyr/zephyr.bin"
DEFAULT_APP_VERSION="0x00040000"
DEFAULT_RESET_DELAY_MS=300
# Roughly how long the BL should hold before its watchdog gives up
# and jumps back to the app. Tune to whatever B-2's spec lands on.
DEFAULT_BL_WATCHDOG_S=30

chmod +x "$EXECUTABLE" 2>/dev/null

read_input() {
    local prompt="$1"
    local var_name="$2"
    read -r -p "$prompt" "$var_name"
}

press_enter() {
    read -r -p "$1 (press ENTER when ready) " _
}

sleep_ms() {
    local ms="$1"
    python3 -c "import time; time.sleep($ms / 1000.0)" 2>/dev/null || \
    perl -e "select(undef, undef, undef, $ms / 1000.0)" 2>/dev/null || \
    sleep 0.2
}

validate_slot() {
    local v="$1"
    [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge "$SLOT_INDEX_MINIMUM" ] && [ "$v" -le "$SLOT_INDEX_MAXIMUM" ]
}

validate_board() {
    local v="$1"
    [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge "$BOARD_ADDRESS_MINIMUM" ] && [ "$v" -le "$BOARD_ADDRESS_MAXIMUM" ]
}

ask_slot() {
    local var_name="$1"
    local prompt="${2:-Enter slot index ($SLOT_INDEX_MINIMUM-$SLOT_INDEX_MAXIMUM): }"
    local value
    read_input "$prompt" value
    value=$(echo "$value" | tr -d '[:space:]')
    if ! validate_slot "$value"; then
        echo "Error: invalid slot index '$value'" >&2
        return 1
    fi
    printf -v "$var_name" '%s' "$value"
}

ask_board() {
    local var_name="$1"
    local prompt="${2:-Enter board address ($BOARD_ADDRESS_MINIMUM-$BOARD_ADDRESS_MAXIMUM): }"
    local value
    read_input "$prompt" value
    value=$(echo "$value" | tr -d '[:space:]')
    if ! validate_board "$value"; then
        echo "Error: invalid board address '$value'" >&2
        return 1
    fi
    printf -v "$var_name" '%s' "$value"
}

ask_image() {
    local var_name="$1"
    local default_path="$2"
    local value
    read_input "Image path [default: $default_path]: " value
    if [ -z "$value" ]; then value="$default_path"; fi
    if [ ! -f "$value" ]; then
        echo "Error: image not found at: $value" >&2
        return 1
    fi
    printf -v "$var_name" '%s' "$value"
}

# Wrapper: run a CLI subcommand, echo to stdout, stash result in
# globals LAST_OUTPUT / LAST_RC / LAST_SUCCESS.
run_cli() {
    local label="$1"; shift
    echo "--- $label : $* ---"
    LAST_OUTPUT=$("$EXECUTABLE" "$@" 2>&1)
    LAST_RC=$?
    echo "$LAST_OUTPUT"
    echo "(rc=$LAST_RC)"
    LAST_SUCCESS="unknown"
    if [ "$LAST_RC" -eq 0 ] && command -v jq &> /dev/null \
       && echo "$LAST_OUTPUT" | jq empty 2>/dev/null; then
        LAST_SUCCESS=$(echo "$LAST_OUTPUT" | jq -r '.success // "unknown"' 2>/dev/null)
    fi
    echo ""
}

new_log() {
    local tag="$1"
    local ts
    ts=$(date +%Y%m%d_%H%M%S)
    echo "$SCRIPT_DIR/firmware_fixes_${tag}_${ts}.log"
}

############################################
# Test 1: PB FWU power-cycle (DATA + FINISH)
############################################
test_pb_fwu_powercycle() {
    local slot image version log
    ask_slot slot || return 1
    ask_image image "$DEFAULT_PB_IMAGE" || return 1
    read_input "App version hex [default: $DEFAULT_APP_VERSION]: " version
    [ -z "$version" ] && version="$DEFAULT_APP_VERSION"

    log=$(new_log "pb_fwu_powercycle_slot${slot}")

    {
        echo "PB FWU power-cycle test - $(date)"
        echo "Slot: $slot   Image: $image   Version: $version"
        echo ""
        echo "Goal: kill power during DATA phase, restore, repeat; then"
        echo "      kill power during FINISH/CRC phase. After each kill"
        echo "      the unit must boot back (no brick) and a fresh FWU"
        echo "      must complete successfully."
        echo ""

        # Phase A — kill during DATA -----------------------------------
        echo "=========================================="
        echo "Phase A: kill power during DATA phase"
        echo "=========================================="
        press_enter "Watch verbose output — kill power partway through the chunk loop."
        run_cli "PB_FWU (expect interruption)" pb-firmware-update \
            -i "$slot" --image "$image" --app-version "$version" --verbose
        if [ "$LAST_RC" -eq 0 ] && [ "$LAST_SUCCESS" = "true" ]; then
            echo "[WARN] FWU finished without being interrupted — try again, kill earlier."
        else
            echo "[OK-EXPECTED] FWU aborted (rc=$LAST_RC success=$LAST_SUCCESS)."
        fi

        press_enter "Restore power to the powerbank, give it a couple of seconds to boot."
        sleep_ms 1500

        echo "Probing app side with pb-firmware ..."
        run_cli "post-cycle pb-firmware" pb-firmware -i "$slot"
        echo "Probing bootloader side with pb-fwu-hello (also wakes BL if app was killed) ..."
        run_cli "post-cycle pb-fwu-hello" pb-fwu-hello -i "$slot"

        if [ "$LAST_SUCCESS" = "true" ]; then
            echo "[OK] Bootloader still answers — unit is not bricked."
        else
            echo "[FAIL] Bootloader did not answer pb-fwu-hello — possible brick or stuck-in-app."
        fi

        echo "Attempting recovery FWU to confirm the device is fully usable ..."
        run_cli "recovery PB_FWU" pb-firmware-update \
            -i "$slot" --image "$image" --app-version "$version" --verbose
        if [ "$LAST_SUCCESS" = "true" ]; then
            echo "[OK] Recovery FWU completed."
        else
            echo "[FAIL] Recovery FWU did not complete."
        fi

        # Phase B — kill during FINISH/CRC -----------------------------
        echo ""
        echo "=========================================="
        echo "Phase B: kill power during FINISH / CRC phase"
        echo "=========================================="
        press_enter "Watch output — kill power right when the chunk loop ends and FINISH/CRC begins."
        run_cli "PB_FWU (expect FINISH interruption)" pb-firmware-update \
            -i "$slot" --image "$image" --app-version "$version" --verbose
        if [ "$LAST_RC" -eq 0 ] && [ "$LAST_SUCCESS" = "true" ]; then
            echo "[WARN] FWU finished without being interrupted — try again."
        else
            echo "[OK-EXPECTED] FWU aborted in FINISH/CRC phase."
        fi

        press_enter "Restore power, wait for boot."
        sleep_ms 1500

        run_cli "post-cycle pb-fwu-hello" pb-fwu-hello -i "$slot"
        if [ "$LAST_SUCCESS" = "true" ]; then
            echo "[OK] BL alive after FINISH-phase kill — half-flashed image must NOT have been marked valid."
        else
            echo "[FAIL] BL silent after FINISH-phase kill."
        fi

        echo ""
        echo "Final recovery FWU ..."
        run_cli "final recovery PB_FWU" pb-firmware-update \
            -i "$slot" --image "$image" --app-version "$version" --verbose
        [ "$LAST_SUCCESS" = "true" ] && echo "[OK] Recovered." || echo "[FAIL] Could not recover."

        echo ""
        echo "End of PB FWU power-cycle test."
    } 2>&1 | tee "$log"
    echo "Log: $log"
}

############################################
# Test 2: BL watchdog fallback (B-2, B-29)
############################################
test_bl_watchdog_fallback() {
    local slot timeout_s log
    ask_slot slot || return 1
    read_input "BL watchdog timeout to wait in seconds [default: $DEFAULT_BL_WATCHDOG_S]: " timeout_s
    [ -z "$timeout_s" ] && timeout_s="$DEFAULT_BL_WATCHDOG_S"
    if ! [[ "$timeout_s" =~ ^[0-9]+$ ]] || [ "$timeout_s" -lt 1 ]; then
        echo "Error: bad timeout '$timeout_s'" >&2; return 1
    fi

    log=$(new_log "bl_watchdog_slot${slot}")
    {
        echo "BL watchdog fallback test - $(date)"
        echo "Slot: $slot   Wait window: ${timeout_s}s"
        echo ""
        echo "Goal: enter BL via pb-enter-boot, then DO NOT talk to it"
        echo "      for ${timeout_s}s. BL must time out and jump back to"
        echo "      app on its own (B-2). pb-firmware after the wait"
        echo "      should answer (app), pb-fwu-hello should not"
        echo "      (BL is gone)."
        echo ""

        run_cli "pre-test pb-firmware (app should answer)" pb-firmware -i "$slot"
        if [ "$LAST_SUCCESS" != "true" ]; then
            echo "[ABORT] App not answering before test, cannot continue."
            return 1
        fi

        run_cli "pb-enter-boot" pb-enter-boot -i "$slot"
        if [ "$LAST_SUCCESS" != "true" ]; then
            echo "[FAIL] pb-enter-boot did not succeed; cannot stage watchdog scenario."
            return 1
        fi

        # Verify we ARE in BL right now.
        sleep_ms "$DEFAULT_RESET_DELAY_MS"
        run_cli "pb-fwu-hello immediately after enter-boot" pb-fwu-hello -i "$slot"
        if [ "$LAST_SUCCESS" != "true" ]; then
            echo "[WARN] BL did not answer right after enter-boot. State of test is unclear."
        fi

        echo "Now waiting ${timeout_s}s WITHOUT talking to the PB ..."
        sleep "$timeout_s"

        echo "Window elapsed. Now probing app side first."
        run_cli "post-wait pb-firmware (expect app=true)" pb-firmware -i "$slot"
        local app_alive="$LAST_SUCCESS"

        run_cli "post-wait pb-fwu-hello (expect BL gone)" pb-fwu-hello -i "$slot"
        local bl_alive="$LAST_SUCCESS"

        if [ "$app_alive" = "true" ] && [ "$bl_alive" != "true" ]; then
            echo "[PASS] App reachable, BL no longer reachable — watchdog fired."
        elif [ "$app_alive" = "true" ] && [ "$bl_alive" = "true" ]; then
            echo "[AMBIG] Both app and BL appear to answer (?) — re-check CLI routing."
        elif [ "$app_alive" != "true" ] && [ "$bl_alive" = "true" ]; then
            echo "[FAIL] Still parked in BL after ${timeout_s}s — B-2 watchdog likely missing or too long."
        else
            echo "[FAIL] Neither app nor BL responding — possible brick."
        fi
    } 2>&1 | tee "$log"
    echo "Log: $log"
}

############################################
# Test 3: Back-to-back PB FWU (B-13)
############################################
test_pb_fwu_back_to_back() {
    local slot image version log
    ask_slot slot || return 1
    ask_image image "$DEFAULT_PB_IMAGE" || return 1
    read_input "App version hex [default: $DEFAULT_APP_VERSION]: " version
    [ -z "$version" ] && version="$DEFAULT_APP_VERSION"

    log=$(new_log "pb_fwu_back_to_back_slot${slot}")
    {
        echo "PB FWU back-to-back test - $(date)"
        echo "Slot: $slot   Image: $image"
        echo ""
        echo "Goal: two consecutive successful FWUs without any reset"
        echo "      of the station in between. Second one must not be"
        echo "      poisoned by stale BL events from the first (B-13)."
        echo ""

        run_cli "FWU #1" pb-firmware-update \
            -i "$slot" --image "$image" --app-version "$version" --verbose
        local first="$LAST_SUCCESS"

        sleep_ms 500

        run_cli "FWU #2 (back-to-back)" pb-firmware-update \
            -i "$slot" --image "$image" --app-version "$version" --verbose
        local second="$LAST_SUCCESS"

        if [ "$first" = "true" ] && [ "$second" = "true" ]; then
            echo "[PASS] Both back-to-back FWUs succeeded."
        else
            echo "[FAIL] first=$first second=$second — investigate stale-event handling."
        fi
    } 2>&1 | tee "$log"
    echo "Log: $log"
}

############################################
# Test 4: Station FWU power-cycle
############################################
test_station_fwu_powercycle() {
    local board image version log
    ask_board board || return 1
    ask_image image "$DEFAULT_ST_IMAGE" || return 1
    read_input "App version hex [default: $DEFAULT_APP_VERSION]: " version
    [ -z "$version" ] && version="$DEFAULT_APP_VERSION"

    log=$(new_log "station_fwu_powercycle_board${board}")
    {
        echo "Station FWU power-cycle test - $(date)"
        echo "Board: $board   Image: $image"
        echo ""
        echo "Goal: same as PB FWU power-cycle but for the station's"
        echo "      RS-485-resident bootloader."
        echo ""

        # Phase A — DATA -----------------------------------------------
        press_enter "Phase A: kill station power partway through DATA phase."
        run_cli "station FWU (expect DATA interruption)" firmware-update \
            -b "$board" --image "$image" --app-version "$version" --verbose
        [ "$LAST_SUCCESS" = "true" ] && echo "[WARN] not interrupted, retry" \
                                     || echo "[OK-EXPECTED] interrupted in DATA"

        press_enter "Restore power, wait for boot."
        sleep_ms 2000

        run_cli "post-cycle fwu-hello" fwu-hello -b "$board"
        [ "$LAST_SUCCESS" = "true" ] && echo "[OK] BL alive" \
                                     || echo "[FAIL] BL silent"

        run_cli "recovery station FWU" firmware-update \
            -b "$board" --image "$image" --app-version "$version" --verbose
        [ "$LAST_SUCCESS" = "true" ] && echo "[OK] recovered" \
                                     || echo "[FAIL] could not recover"

        # Phase B — FINISH ---------------------------------------------
        press_enter "Phase B: kill station power during FINISH/CRC phase."
        run_cli "station FWU (expect FINISH interruption)" firmware-update \
            -b "$board" --image "$image" --app-version "$version" --verbose
        [ "$LAST_SUCCESS" = "true" ] && echo "[WARN] not interrupted, retry" \
                                     || echo "[OK-EXPECTED] interrupted in FINISH"

        press_enter "Restore power, wait for boot."
        sleep_ms 2000

        run_cli "post-cycle fwu-hello" fwu-hello -b "$board"
        [ "$LAST_SUCCESS" = "true" ] && echo "[OK] BL alive after FINISH kill" \
                                     || echo "[FAIL] BL silent after FINISH kill"

        run_cli "final recovery station FWU" firmware-update \
            -b "$board" --image "$image" --app-version "$version" --verbose
        [ "$LAST_SUCCESS" = "true" ] && echo "[OK] final recovery ok" \
                                     || echo "[FAIL] final recovery failed"
    } 2>&1 | tee "$log"
    echo "Log: $log"
}

############################################
# Test 5: B-1 divide-by-zero (totalCap == cutoffCap)
############################################
test_b1_divide_by_zero() {
    local slot id total_cap cutoff_cap log
    ask_slot slot || return 1
    read_input "Powerbank serial number (exactly 10 chars) [default: TESTPB0001]: " id
    [ -z "$id" ] && id="TESTPB0001"
    read_input "totalCap mAh [default: 10000]: " total_cap
    [ -z "$total_cap" ] && total_cap=10000
    cutoff_cap="$total_cap"   # the actual test: equal values

    log=$(new_log "b1_divbyzero_slot${slot}")
    {
        echo "B-1 divide-by-zero test - $(date)"
        echo "Slot: $slot   id: $id   totalCap=cutoffCap=$total_cap"
        echo ""
        echo "Goal: firmware must reject CMD_SET_BINFO when totalCap =="
        echo "      cutoffCap, instead of dividing by zero on the next"
        echo "      SOC read."
        echo ""

        run_cli "initialize-powerbank (degenerate caps)" initialize-powerbank \
            -i "$slot" --id "$id" \
            --total-charge "$total_cap" --cutoff-charge "$cutoff_cap"

        if [ "$LAST_SUCCESS" = "true" ]; then
            echo "[FAIL] firmware ACCEPTED totalCap == cutoffCap — divide-by-zero risk remains."
        else
            echo "[OK-EXPECTED] firmware rejected degenerate caps."
        fi

        # Even if it accepted, prove no crash on next SOC read.
        run_cli "follow-up status (must not crash)" status -i "$slot"
        [ "$LAST_RC" -eq 0 ] && echo "[OK] status still answers (no crash)" \
                             || echo "[FAIL] status not answering — PB may have hung."
    } 2>&1 | tee "$log"
    echo "Log: $log"
}

############################################
# Test 6: Charge-cycle SOC monitor (long)
############################################
test_charge_cycle_monitor() {
    local slot interval_s max_minutes log
    ask_slot slot || return 1
    read_input "Sample interval seconds [default: 30]: " interval_s
    [ -z "$interval_s" ] && interval_s=30
    read_input "Max monitor duration in minutes [default: 240]: " max_minutes
    [ -z "$max_minutes" ] && max_minutes=240

    log=$(new_log "charge_cycle_slot${slot}")
    {
        echo "Charge-cycle SOC monitor - $(date)"
        echo "Slot: $slot   sample every ${interval_s}s   up to ${max_minutes} min"
        echo ""
        echo "Goal: leave a discharged PB charging. % climbs smoothly,"
        echo "      no sticking, snaps to 100% when GPIO_IsChargeFull()"
        echo "      asserts (FeNFivk05 + B-1 soft-total)."
        echo ""
        echo "      Format: ts_iso  rc  success  percent  state"
        echo ""

        local end_epoch=$(( $(date +%s) + max_minutes * 60 ))
        while [ "$(date +%s)" -lt "$end_epoch" ]; do
            local out rc pct state success
            out=$("$EXECUTABLE" status -i "$slot" 2>&1)
            rc=$?
            success="?"; pct="?"; state="?"
            if command -v jq &> /dev/null && echo "$out" | jq empty 2>/dev/null; then
                success=$(echo "$out" | jq -r '.success // "?"')
                pct=$(echo "$out" | jq -r '.percent // .soc // .charge // "?"')
                state=$(echo "$out" | jq -r '.state // .chargeState // .status // "?"')
            fi
            printf '%s  rc=%s  success=%s  pct=%s  state=%s\n' \
                "$(date -Iseconds)" "$rc" "$success" "$pct" "$state"
            sleep "$interval_s"
        done

        echo ""
        echo "Monitor window elapsed."
        echo "Eyeball the column: pct should rise monotonically to 100,"
        echo "                    state should land in CHARGED with no oscillation."
    } 2>&1 | tee "$log"
    echo "Log: $log"
}

############################################
# Test 7: Self-discharge re-enter CHARGING (long)
############################################
test_self_discharge_recharge() {
    local slot interval_s max_minutes log
    ask_slot slot || return 1
    read_input "Sample interval seconds [default: 60]: " interval_s
    [ -z "$interval_s" ] && interval_s=60
    read_input "Max monitor duration in minutes [default: 720]: " max_minutes
    [ -z "$max_minutes" ] && max_minutes=720

    log=$(new_log "selfdischarge_slot${slot}")
    {
        echo "Self-discharge → re-enter CHARGING test - $(date)"
        echo "Slot: $slot   sample every ${interval_s}s   up to ${max_minutes} min"
        echo ""
        echo "Goal: PB sits docked at CHARGED. Expect it to re-enter"
        echo "      CHARGING after some self-discharge (B-26)."
        echo ""

        local end_epoch=$(( $(date +%s) + max_minutes * 60 ))
        local seen_recharge=0
        while [ "$(date +%s)" -lt "$end_epoch" ]; do
            local out rc pct state success
            out=$("$EXECUTABLE" status -i "$slot" 2>&1)
            rc=$?
            success="?"; pct="?"; state="?"
            if command -v jq &> /dev/null && echo "$out" | jq empty 2>/dev/null; then
                success=$(echo "$out" | jq -r '.success // "?"')
                pct=$(echo "$out" | jq -r '.percent // .soc // .charge // "?"')
                state=$(echo "$out" | jq -r '.state // .chargeState // .status // "?"')
            fi
            printf '%s  rc=%s  success=%s  pct=%s  state=%s\n' \
                "$(date -Iseconds)" "$rc" "$success" "$pct" "$state"
            if echo "$state" | grep -qi 'charging'; then
                seen_recharge=1
            fi
            sleep "$interval_s"
        done

        echo ""
        if [ "$seen_recharge" -eq 1 ]; then
            echo "[PASS] saw CHARGING state at least once — top-off fires."
        else
            echo "[FAIL] never re-entered CHARGING — B-26 likely still broken."
        fi
    } 2>&1 | tee "$log"
    echo "Log: $log"
}

############################################
# Test 8: Cross-slot transaction isolation
############################################
test_cross_slot_isolation() {
    local slot_a slot_b iterations log
    ask_slot slot_a "Enter FIRST slot index (issues pb-enter-boot): " || return 1
    ask_slot slot_b "Enter SECOND slot index (issues status):       " || return 1
    if [ "$slot_a" = "$slot_b" ]; then
        echo "Error: slots must differ." >&2
        return 1
    fi
    read_input "Iterations [default: 20]: " iterations
    [ -z "$iterations" ] && iterations=20

    log=$(new_log "crossslot_${slot_a}_${slot_b}")
    {
        echo "Cross-slot transaction isolation test - $(date)"
        echo "Slot A: $slot_a (enter-boot)   Slot B: $slot_b (status)"
        echo "Iterations: $iterations"
        echo ""
        echo "Goal: issue pb-enter-boot on A then IMMEDIATELY status on"
        echo "      B before A's reply has been processed. B must get a"
        echo "      correct, non-poisoned reply (B-13, B-36, B-38)."
        echo ""

        local pass=0 fail=0
        for ((i=1; i<=iterations; i++)); do
            echo "[iter $i/$iterations]"
            "$EXECUTABLE" pb-enter-boot -i "$slot_a" >/dev/null 2>&1 &
            local pid=$!
            # No sleep on purpose — we WANT the overlap.
            local out
            out=$("$EXECUTABLE" status -i "$slot_b" 2>&1)
            local rc=$?
            wait "$pid" 2>/dev/null
            local success="?"
            if command -v jq &> /dev/null && echo "$out" | jq empty 2>/dev/null; then
                success=$(echo "$out" | jq -r '.success // "?"')
            fi
            echo "  status(slot $slot_b) rc=$rc success=$success"
            if [ "$rc" -eq 0 ] && [ "$success" = "true" ]; then
                pass=$((pass+1))
            else
                fail=$((fail+1))
                echo "  raw: $out"
            fi
            # Let slot A drop back into app between iterations.
            sleep_ms "$DEFAULT_RESET_DELAY_MS"
            "$EXECUTABLE" pb-fwu-exit -i "$slot_a" >/dev/null 2>&1
            sleep_ms "$DEFAULT_RESET_DELAY_MS"
        done

        echo ""
        echo "Summary: $pass clean, $fail poisoned/failed (of $iterations)"
        if [ "$fail" -eq 0 ]; then
            echo "[PASS] B's transaction never poisoned by A's stale event."
        else
            echo "[FAIL] $fail iteration(s) of B were poisoned — fix not effective."
        fi
    } 2>&1 | tee "$log"
    echo "Log: $log"
}

############################################
# Test 9: FW version string length (V-26/B-40)
############################################
test_fw_version_length() {
    local slot board log
    ask_slot slot "Enter slot index for pb-firmware (or empty to skip PB side): "
    read_input "Enter board address for station firmware (or empty to skip): " board

    log=$(new_log "fw_version_length")
    {
        echo "FW version string length read-back - $(date)"
        echo ""
        echo "Goal: regression check for V-26/B-40 — confirm a long"
        echo "      (31+ char) FW version string round-trips through"
        echo "      the version-read path without truncation/crash."
        echo "      NOTE: the firmware must have been built with a long"
        echo "            FW_VERSION string for this test to exercise"
        echo "            the bug; otherwise it just verifies the field"
        echo "            is non-empty."
        echo ""

        if [ -n "$slot" ]; then
            if validate_slot "$slot"; then
                run_cli "pb-firmware" pb-firmware -i "$slot"
                if command -v jq &> /dev/null && echo "$LAST_OUTPUT" | jq empty 2>/dev/null; then
                    local v len
                    v=$(echo "$LAST_OUTPUT" | jq -r '.fwVersion // .version // .firmwareVersion // ""')
                    len=${#v}
                    echo "  PB FW version string: '$v' (len=$len)"
                    if [ "$len" -ge 31 ]; then
                        echo "  [OK] long string (>=31) round-tripped intact."
                    else
                        echo "  [INFO] string shorter than 31 chars — V-26 path not exercised by current firmware."
                    fi
                fi
            else
                echo "[SKIP] bad slot index"
            fi
        fi

        if [ -n "$board" ]; then
            if validate_board "$board"; then
                run_cli "firmware (station)" firmware -b "$board"
                if command -v jq &> /dev/null && echo "$LAST_OUTPUT" | jq empty 2>/dev/null; then
                    local v len
                    v=$(echo "$LAST_OUTPUT" | jq -r '.fwVersion // .version // .firmwareVersion // ""')
                    len=${#v}
                    echo "  Station FW version string: '$v' (len=$len)"
                    if [ "$len" -ge 31 ]; then
                        echo "  [OK] long string (>=31) round-tripped intact."
                    else
                        echo "  [INFO] string shorter than 31 chars — V-26 path not exercised."
                    fi
                fi
            else
                echo "[SKIP] bad board address"
            fi
        fi
    } 2>&1 | tee "$log"
    echo "Log: $log"
}

############################################
# Test 10: Non-interactive subset
############################################
test_all_non_interactive() {
    echo ""
    echo "Running every sub-test that does NOT need a power-pull."
    echo "You will still be prompted for slot indices/etc."
    echo ""
    test_pb_fwu_back_to_back
    echo ""
    test_b1_divide_by_zero
    echo ""
    test_cross_slot_isolation
    echo ""
    test_fw_version_length
    echo ""
    echo "Skipped (need human action / hours):"
    echo "  1) PB FWU power-cycle"
    echo "  2) BL watchdog fallback"
    echo "  4) Station FWU power-cycle"
    echo "  6) Charge-cycle monitor"
    echo "  7) Self-discharge re-enter CHARGING"
}

############################################
# Menu
############################################
print_menu() {
    cat <<'EOF'

Firmware-fixes test suite
=========================
 1) PB FWU power-cycle (mid-DATA + mid-FINISH)         [needs power-pull]
 2) BL watchdog fallback                               [needs ~30s wait]
 3) Back-to-back PB FWU
 4) Station FWU power-cycle (mid-DATA + mid-FINISH)    [needs power-pull]
 5) B-1 divide-by-zero (totalCap == cutoffCap)
 6) Charge-cycle SOC monitor                           [long, hours]
 7) Self-discharge re-enter CHARGING                   [long, hours]
 8) Cross-slot transaction isolation
 9) FW version string length regression
10) Run all non-interactive tests (3, 5, 8, 9)
 q) quit

NOT covered (need raw-frame injection — use a dedicated fuzzer):
  - sub-5B frame to station (B-18 / V-22)
  - garbage > UART_FRAME_MAX_LEN (V-21)
  - malformed FWU reply with next_expected_offset = 0xFFFFFFFF (V-19)

EOF
}

main() {
    while true; do
        print_menu
        read -r -p "Pick a test: " choice
        case "$choice" in
            1)  test_pb_fwu_powercycle ;;
            2)  test_bl_watchdog_fallback ;;
            3)  test_pb_fwu_back_to_back ;;
            4)  test_station_fwu_powercycle ;;
            5)  test_b1_divide_by_zero ;;
            6)  test_charge_cycle_monitor ;;
            7)  test_self_discharge_recharge ;;
            8)  test_cross_slot_isolation ;;
            9)  test_fw_version_length ;;
            10) test_all_non_interactive ;;
            q|Q) break ;;
            *)  echo "Unknown choice." ;;
        esac
    done
}

main
