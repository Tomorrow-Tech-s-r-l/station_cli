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
DEFAULT_DELAY_MS=5

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
    # Convert milliseconds to seconds (5ms = 0.005s)
    python3 -c "import time; time.sleep($ms / 1000.0)" 2>/dev/null || \
    perl -e "select(undef, undef, undef, $ms / 1000.0)" 2>/dev/null || \
    sleep 0.005
}

# Ask for index
read_input "Enter slot index ($SLOT_INDEX_MINIMUM-$SLOT_INDEX_MAXIMUM): " index
index=$(echo "$index" | tr -d '[:space:]')

# Validate index
if ! [[ "$index" =~ ^[0-9]+$ ]] || [ "$index" -lt "$SLOT_INDEX_MINIMUM" ] || [ "$index" -gt "$SLOT_INDEX_MAXIMUM" ]; then
    echo "Error: Invalid index. Must be between $SLOT_INDEX_MINIMUM and $SLOT_INDEX_MAXIMUM" >&2
    exit 1
fi

# Ask for number of times
read_input "Enter number of times to interrogate: " times
times=$(echo "$times" | tr -d '[:space:]')

# Validate times
if ! [[ "$times" =~ ^[0-9]+$ ]] || [ "$times" -lt 1 ]; then
    echo "Error: Invalid number. Must be at least 1" >&2
    exit 1
fi

# Ask for delay (default is 5ms)
read_input "Enter delay in milliseconds (default: $DEFAULT_DELAY_MS ms): " delay_input
delay_input=$(echo "$delay_input" | tr -d '[:space:]')

# Use default if empty, otherwise validate
if [ -z "$delay_input" ]; then
    delay_ms_value=$DEFAULT_DELAY_MS
else
    # Validate delay - must be a positive number (can be decimal)
    if ! [[ "$delay_input" =~ ^[0-9]+\.?[0-9]*$ ]]; then
        echo "Error: Invalid delay. Must be a positive number" >&2
        exit 1
    fi
    # Check if it's greater than 0 using awk (more portable than bc)
    if ! awk "BEGIN {exit !($delay_input > 0)}" 2>/dev/null; then
        echo "Error: Invalid delay. Must be greater than 0" >&2
        exit 1
    fi
    delay_ms_value="$delay_input"
fi

echo ""
echo "Interrogating status for index $index, $times time(s) with ${delay_ms_value}ms delay..."
echo ""

# Initialize counters
success_count=0
timeout_failure_count=0

# Execute status command multiple times with delay
for ((i=1; i<=times; i++)); do
    echo "[$i/$times] Executing status command..."
    
    # Execute the command and capture output
    output=$("$EXECUTABLE" status -i "$index" 2>&1)
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
                    ((success_count++))
                elif [ "$success" = "false" ] && [ "$error_code" = "1" ] && [ "$error_message" = "Device timeout - device not responding" ]; then
                    ((timeout_failure_count++))
                fi
            fi
        else
            # Fallback: use grep to check for patterns (works with single-line or multi-line JSON)
            if echo "$output" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
                ((success_count++))
            elif echo "$output" | grep -q '"success"[[:space:]]*:[[:space:]]*false' && \
                 echo "$output" | grep -q '"code"[[:space:]]*:[[:space:]]*1' && \
                 echo "$output" | grep -q 'Device timeout - device not responding'; then
                ((timeout_failure_count++))
            fi
        fi
    else
        echo "Error:"
        echo "$output"
    fi
    
    # Add delay between calls (except after the last one)
    if [ $i -lt $times ]; then
        delay_ms "$delay_ms_value"
    fi
    
    echo "" # Empty line for readability
done

echo "Interrogation complete!"
echo ""
echo "Summary:"
echo "  Successful: $success_count"
echo "  Timeout failures: $timeout_failure_count"
