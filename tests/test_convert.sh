#!/bin/bash

# Test script for the convert command
# This script tests the hex frame converter with various inputs

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to run convert command
run_convert() {
    local hex_input="$1"
    local description="$2"
    
    echo -e "${YELLOW}Testing: $description${NC}"
    echo "Input: $hex_input"
    echo "---"
    
    if [ -f "$PROJECT_DIR/dist/cli.js" ]; then
        node "$PROJECT_DIR/dist/cli.js" convert "$hex_input"
    elif [ -f "$PROJECT_DIR/executables/station-cli-macos-arm64" ]; then
        "$PROJECT_DIR/executables/station-cli-macos-arm64" convert "$hex_input"
    elif [ -f "$PROJECT_DIR/executables/station-cli-linux-arm64" ]; then
        "$PROJECT_DIR/executables/station-cli-linux-arm64" convert "$hex_input"
    elif [ -f "$PROJECT_DIR/executables/station-cli-windows-x64.exe" ]; then
        "$PROJECT_DIR/executables/station-cli-windows-x64.exe" convert "$hex_input"
    else
        echo -e "${RED}Error: No CLI executable found. Please build the project first.${NC}"
        exit 1
    fi
    
    local exit_code=$?
    if [ $exit_code -eq 0 ]; then
        echo -e "${GREEN}✓ Test passed${NC}"
    else
        echo -e "${RED}✗ Test failed (exit code: $exit_code)${NC}"
    fi
    echo ""
}

# Test cases
echo "=========================================="
echo "Testing Convert Command"
echo "=========================================="
echo ""

# Test 1: SLOTS command (with spaces)
run_convert "ea 01 05 c0 23" "SLOTS command (board 1) - with spaces"

# Test 2: SLOTS command (without spaces)
run_convert "ea0105c023" "SLOTS command (board 1) - without spaces"

# Test 3: UNLOCK command
run_convert "ea 01 06 01 41 1c" "UNLOCK command (board 1, slot 1)"

# Test 4: STATUS command
run_convert "ea 00 01 00 40 1c" "STATUS command (board 0, slot 0)"

# Test 5: SET_CHARGE command
run_convert "ea 01 02 01 64 21 1c" "SET_CHARGE command (board 1, slot 1, power level 100)"

# Test 6: Invalid start frame (should fail)
echo -e "${YELLOW}Testing: Invalid start frame (should fail)${NC}"
echo "Input: ff 01 05 c0 23"
echo "---"
if [ -f "$PROJECT_DIR/dist/cli.js" ]; then
    node "$PROJECT_DIR/dist/cli.js" convert "ff 01 05 c0 23" 2>&1
elif [ -f "$PROJECT_DIR/executables/station-cli-macos-arm64" ]; then
    "$PROJECT_DIR/executables/station-cli-macos-arm64" convert "ff 01 05 c0 23" 2>&1
elif [ -f "$PROJECT_DIR/executables/station-cli-linux-arm64" ]; then
    "$PROJECT_DIR/executables/station-cli-linux-arm64" convert "ff 01 05 c0 23" 2>&1
elif [ -f "$PROJECT_DIR/executables/station-cli-windows-x64.exe" ]; then
    "$PROJECT_DIR/executables/station-cli-windows-x64.exe" convert "ff 01 05 c0 23" 2>&1
fi
if [ $? -ne 0 ]; then
    echo -e "${GREEN}✓ Test passed (correctly rejected invalid frame)${NC}"
else
    echo -e "${RED}✗ Test failed (should have rejected invalid frame)${NC}"
fi
echo ""

# Test 7: Invalid hex string (should fail)
echo -e "${YELLOW}Testing: Invalid hex string (should fail)${NC}"
echo "Input: ea 01 05 gx"
echo "---"
if [ -f "$PROJECT_DIR/dist/cli.js" ]; then
    node "$PROJECT_DIR/dist/cli.js" convert "ea 01 05 gx" 2>&1
elif [ -f "$PROJECT_DIR/executables/station-cli-macos-arm64" ]; then
    "$PROJECT_DIR/executables/station-cli-macos-arm64" convert "ea 01 05 gx" 2>&1
elif [ -f "$PROJECT_DIR/executables/station-cli-linux-arm64" ]; then
    "$PROJECT_DIR/executables/station-cli-linux-arm64" convert "ea 01 05 gx" 2>&1
elif [ -f "$PROJECT_DIR/executables/station-cli-windows-x64.exe" ]; then
    "$PROJECT_DIR/executables/station-cli-windows-x64.exe" convert "ea 01 05 gx" 2>&1
fi
if [ $? -ne 0 ]; then
    echo -e "${GREEN}✓ Test passed (correctly rejected invalid hex)${NC}"
else
    echo -e "${RED}✗ Test failed (should have rejected invalid hex)${NC}"
fi
echo ""

# Test 8: Odd number of hex characters (should fail)
echo -e "${YELLOW}Testing: Odd number of hex characters (should fail)${NC}"
echo "Input: ea 01 05 c"
echo "---"
if [ -f "$PROJECT_DIR/dist/cli.js" ]; then
    node "$PROJECT_DIR/dist/cli.js" convert "ea 01 05 c" 2>&1
elif [ -f "$PROJECT_DIR/executables/station-cli-macos-arm64" ]; then
    "$PROJECT_DIR/executables/station-cli-macos-arm64" convert "ea 01 05 c" 2>&1
elif [ -f "$PROJECT_DIR/executables/station-cli-linux-arm64" ]; then
    "$PROJECT_DIR/executables/station-cli-linux-arm64" convert "ea 01 05 c" 2>&1
elif [ -f "$PROJECT_DIR/executables/station-cli-windows-x64.exe" ]; then
    "$PROJECT_DIR/executables/station-cli-windows-x64.exe" convert "ea 01 05 c" 2>&1
fi
if [ $? -ne 0 ]; then
    echo -e "${GREEN}✓ Test passed (correctly rejected odd-length hex)${NC}"
else
    echo -e "${RED}✗ Test failed (should have rejected odd-length hex)${NC}"
fi
echo ""

echo "=========================================="
echo "All tests completed"
echo "=========================================="

