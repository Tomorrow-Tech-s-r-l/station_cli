#!/bin/bash
#
# Phase 4 + Phase 5 firmware-update integration test for the P1TT2C
# powerbank.
#
# Drives one end-to-end firmware update through the station's pogo pin:
#
#   firmware-update --index <slot> --image <path-to-bin>
#       → ENTER_BOOT → FWU_HELLO → FWU_BEGIN
#       → loop FWU_DATA (32-byte chunks, ~570 chunks for 18 KB)
#       → FWU_END → FWU_EXIT
#
# Then a follow-up `status` call to confirm the new application is
# running on the slot. Writes a timestamped log alongside the script.

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
DEFAULT_IMAGE_PATH="$SCRIPT_DIR/../../../firmware/P1TT2C-firmware/build_phase3/P1TT2C-firmware.bin"

chmod +x "$EXECUTABLE" 2>/dev/null

read_input() {
    local prompt="$1"
    local var_name="$2"
    read -p "$prompt" "$var_name"
}

read_input "Enter slot index ($SLOT_INDEX_MINIMUM-$SLOT_INDEX_MAXIMUM): " index
index=$(echo "$index" | tr -d '[:space:]')
if ! [[ "$index" =~ ^[0-9]+$ ]] || [ "$index" -lt "$SLOT_INDEX_MINIMUM" ] || [ "$index" -gt "$SLOT_INDEX_MAXIMUM" ]; then
    echo "Error: Invalid index. Must be between $SLOT_INDEX_MINIMUM and $SLOT_INDEX_MAXIMUM" >&2
    exit 1
fi

read_input "Image path [default: $DEFAULT_IMAGE_PATH]: " image
if [ -z "$image" ]; then
    image="$DEFAULT_IMAGE_PATH"
fi
if [ ! -f "$image" ]; then
    echo "Error: Image not found at: $image" >&2
    exit 1
fi
image_size=$(wc -c < "$image" | tr -d '[:space:]')

read_input "App version hex (e.g. 0x00040001) [default: 0x00040000]: " version
if [ -z "$version" ]; then
    version="0x00040000"
fi

echo ""
echo "Firmware-update integration test"
echo "  slot index: $index"
echo "  image:      $image  (${image_size} B)"
echo "  version:    $version"
echo ""

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$SCRIPT_DIR/firmware_update_${TIMESTAMP}.log"

{
    echo "Firmware-update test - $(date)"
    echo "Executable: $EXECUTABLE"
    echo "Slot:    $index"
    echo "Image:   $image"
    echo "Size:    $image_size"
    echo "Version: $version"
    echo ""
    echo "=========================================="
    echo "Step 1 — firmware-update"
    echo "=========================================="

    update_output=$("$EXECUTABLE" firmware-update \
        -i "$index" \
        --image "$image" \
        --app-version "$version" \
        --verbose 2>&1)
    update_rc=$?
    echo "$update_output"
    echo ""
    echo "(firmware-update exit code: $update_rc)"
    echo ""

    if [ $update_rc -ne 0 ]; then
        echo "[FAIL] firmware-update returned non-zero — see output above."
    else
        if command -v jq &> /dev/null; then
            if echo "$update_output" | jq empty 2>/dev/null \
               && [ "$(echo "$update_output" | jq -r '.success')" = "true" ]; then
                duration=$(echo "$update_output" | jq -r '.durationMs')
                chunks=$(echo "$update_output"  | jq -r '.chunks')
                retries=$(echo "$update_output" | jq -r '.retries')
                echo "[OK] update completed in ${duration} ms, ${chunks} chunks, ${retries} retries."
            else
                echo "[FAIL] update reported success=false."
            fi
        fi
    fi

    echo ""
    echo "=========================================="
    echo "Step 2 — post-update status (verifies the new app is running)"
    echo "=========================================="

    status_output=$("$EXECUTABLE" status -i "$index" 2>&1)
    status_rc=$?
    echo "$status_output"
    echo ""
    echo "(status exit code: $status_rc)"
    if [ $status_rc -eq 0 ]; then
        if command -v jq &> /dev/null; then
            success=$(echo "$status_output" | jq -r '.success // false' 2>/dev/null)
            if [ "$success" = "true" ]; then
                echo "[OK] new app answered STATUS."
            else
                echo "[WARN] STATUS returned success=false (powerbank may need a moment more, or the new image hasn't started)."
            fi
        fi
    else
        echo "[FAIL] STATUS exit code non-zero."
    fi
} 2>&1 | tee "$LOG_FILE"

echo ""
echo "Results written to: $LOG_FILE"
