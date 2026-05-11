#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTABLES_DIR="$SCRIPT_DIR/../executables"

# Constants
ALLOWED_MODELS=("S1TT30" "S1TT6")
DEFAULT_DELAY_MS=5

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

# Ask for platform selection
echo "Select platform:"
echo "  1) macOS"
echo "  2) Linux"
echo "  3) Windows"
read_input "Enter selection (1, 2, or 3): " platform_choice
platform_choice=$(echo "$platform_choice" | tr -d '[:space:]')

# Validate and set platform based on selection
case "$platform_choice" in
    1)
        platform="macos"
        executable_name="station-cli-macos-arm64"
        build_command="build:executable:macos"
        ;;
    2)
        platform="linux"
        executable_name="station-cli-linux-arm64"
        build_command="build:executable:linux"
        ;;
    3)
        platform="windows"
        executable_name="station-cli-windows-x64.exe"
        build_command="build:executable:windows"
        ;;
    *)
        echo "Error: Invalid selection. Must be 1, 2, or 3" >&2
        exit 1
        ;;
esac

# Ask for model selection
echo "Select model:"
echo "  1) S1TT30"
echo "  2) S1TT6"
read_input "Enter selection (1 or 2): " model_choice
model_choice=$(echo "$model_choice" | tr -d '[:space:]')

# Validate and set model based on selection. boards[] is the list of board
# addresses we'll target for pb-link-stats reset/read at the start/end of
# this run (BF-260510 validation flow).
case "$model_choice" in
    1)
        model="S1TT30"
        boards=(0 1 2 3 4)
        ;;
    2)
        model="S1TT6"
        boards=(0)
        ;;
    *)
        echo "Error: Invalid selection. Must be 1 or 2" >&2
        exit 1
        ;;
esac

# Ask for number of times to call slots command
read_input "Enter number of times to call slots command: " times
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

# Build the executable
echo ""
echo "Building executable for $platform..."
npm run "$build_command"
if [ $? -ne 0 ]; then
    echo "Error: Build failed" >&2
    exit 1
fi

# Set the executable path based on selected platform
EXECUTABLE="$EXECUTABLES_DIR/$executable_name"

# Check if executable exists
if [ ! -f "$EXECUTABLE" ]; then
    echo "Error: Executable not found: $EXECUTABLE" >&2
    exit 1
fi

# Make executable if not already (only for standalone executables, not node commands)
if [ "$USE_NODE" = "false" ]; then
    chmod +x "$EXECUTABLE" 2>/dev/null
fi

echo ""
echo "Interrogating slots for model $model, $times time(s) with ${delay_ms_value}ms delay..."
echo ""

# Capture pb-link-stats output across all boards. Used both for the start
# reset and the end read. Echoes through the test log so we have a
# permanent record alongside the slot results.
LINK_STATS_BEFORE_FILE=$(mktemp -t interrogate_link_stats_before.XXXXXX)
LINK_STATS_AFTER_FILE=$(mktemp -t interrogate_link_stats_after.XXXXXX)
trap 'rm -f "$ERRORS_FILE" "$EXEC_TIMES_FILE" "$LINK_STATS_BEFORE_FILE" "$LINK_STATS_AFTER_FILE"' EXIT

run_link_stats() {
    # $1 = output file, $2 = "--reset" or empty, $3 = label
    local out_file="$1"
    local reset_flag="$2"
    local label="$3"
    : > "$out_file"
    echo "[$label] pb-link-stats across boards: ${boards[*]}"
    for board in "${boards[@]}"; do
        if [ "$USE_NODE" = "true" ]; then
            stats_output=$(node "$CLI_SCRIPT" "$model" "pb-link-stats" -b "$board" $reset_flag 2>&1)
        else
            stats_output=$("$EXECUTABLE" "$model" "pb-link-stats" -b "$board" $reset_flag 2>&1)
        fi
        {
            echo "--- board $board ---"
            echo "$stats_output"
        } | tee -a "$out_file"
    done
    echo ""
}

# BF-260510 validation: reset the link telemetry so the run starts from
# a clean slate. This makes attempts/retries/final_failures directly
# comparable to the slot-call counts produced below.
run_link_stats "$LINK_STATS_BEFORE_FILE" "--reset" "BEFORE (reset)"

# Initialize counters
total_success_count=0
total_failure_count=0
total_timeout_failure_count=0
total_error_count=0

# Execution time metrics (in ms)
exec_time_count=0
exec_time_sum=0
exec_time_min=""
exec_time_max=""

# Temp file to log every individual error as: boardAddress|slotIndex|error|message|callIndex
ERRORS_FILE=$(mktemp -t interrogate_slots_errors.XXXXXX)
# Temp file to log every captured executionTimeMs (one value per line)
EXEC_TIMES_FILE=$(mktemp -t interrogate_slots_exec_times.XXXXXX)
# (cleanup trap is registered earlier and already covers all four temp files)

# Execute slots command multiple times with delay
for ((i=1; i<=times; i++)); do
    echo "[$i/$times] Executing slots command..."
    
    # Execute the command and capture output
    # Format: executable MODEL slots (matches launch.json format)
    if [ "$USE_NODE" = "true" ]; then
        output=$(node "$CLI_SCRIPT" "$model" "slots" 2>&1)
    else
        output=$("$EXECUTABLE" "$model" "slots" 2>&1)
    fi
    exit_code=$?
    
    call_failed=false
    call_has_timeout=false
    call_has_errors=false
    error_count_in_call=0
    timeout_count_in_call=0
    
    if [ $exit_code -eq 0 ]; then
        echo "Output:"
        echo "$output"
        
        # Check if output contains JSON and parse it
        # Try to parse the output as JSON (it should be valid JSON)
        if command -v jq &> /dev/null; then
            # Try to parse the entire output as JSON
            if echo "$output" | jq empty 2>/dev/null; then
                # Valid JSON, parse it
                # The slots command returns a response with slots array and errors array
                has_slots=$(echo "$output" | jq -r 'has("slots")' 2>/dev/null)
                has_errors=$(echo "$output" | jq -r 'has("errors")' 2>/dev/null)

                # Capture executionTimeMs (top-level field on the SlotsResponse)
                exec_time_value=$(echo "$output" | jq -r '.executionTimeMs // empty' 2>/dev/null)
                if [ -n "$exec_time_value" ] && [[ "$exec_time_value" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
                    echo "$exec_time_value" >> "$EXEC_TIMES_FILE"
                    ((exec_time_count++))
                    exec_time_sum=$(awk "BEGIN {printf \"%.6f\", $exec_time_sum + $exec_time_value}")
                    if [ -z "$exec_time_min" ] || awk "BEGIN {exit !($exec_time_value < $exec_time_min)}"; then
                        exec_time_min="$exec_time_value"
                    fi
                    if [ -z "$exec_time_max" ] || awk "BEGIN {exit !($exec_time_value > $exec_time_max)}"; then
                        exec_time_max="$exec_time_value"
                    fi
                fi
                
                # Check for errors in the errors array
                if [ "$has_errors" = "true" ]; then
                    # Count total errors
                    error_count_in_call=$(echo "$output" | jq -r '.errors | length' 2>/dev/null || echo "0")
                    
                    if [ "$error_count_in_call" -gt 0 ] 2>/dev/null; then
                        call_has_errors=true
                        call_failed=true
                        ((total_error_count+=$error_count_in_call))

                        # Append every error from this call to the errors log
                        # Format: boardAddress|slotIndex|error|message|callIndex
                        echo "$output" | jq -r --arg call "$i" '.errors[]? | "\(.boardAddress // "N/A")|\(.slotIndex // "N/A")|\(.error // "unknown_error")|\(.message // "")|\($call)"' >> "$ERRORS_FILE" 2>/dev/null

                        # Check for timeout errors specifically
                        # Look for errors with message containing "timeout" or "not responding" (case-insensitive)
                        # Also check for connection_error type which often indicates timeout
                        timeout_count_in_call=$(echo "$output" | jq -r '[.errors[]? | select((.message // "" | test("timeout|not responding"; "i")) or (.error // "" | test("connection_error"; "i"))) ] | length' 2>/dev/null || echo "0")
                        
                        if [ "$timeout_count_in_call" -gt 0 ] 2>/dev/null; then
                            call_has_timeout=true
                            ((total_timeout_failure_count+=$timeout_count_in_call))
                        fi
                    fi
                fi
                
                # Consider it successful if we have a slots array AND no errors
                if [ "$has_slots" = "true" ] && [ "$call_failed" = "false" ]; then
                    ((total_success_count++))
                elif [ "$call_failed" = "true" ]; then
                    ((total_failure_count++))
                fi
            else
                # Invalid JSON - consider it a failure
                call_failed=true
                ((total_failure_count++))
            fi
        else
            # Fallback: use grep to check for patterns (works with single-line or multi-line JSON)
            # Capture executionTimeMs via grep (best-effort; works for `"executionTimeMs": 123` or `"executionTimeMs":123.45`)
            exec_time_value=$(echo "$output" | grep -oE '"executionTimeMs"[[:space:]]*:[[:space:]]*[0-9]+(\.[0-9]+)?' | head -n 1 | grep -oE '[0-9]+(\.[0-9]+)?$')
            if [ -n "$exec_time_value" ] && [[ "$exec_time_value" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
                echo "$exec_time_value" >> "$EXEC_TIMES_FILE"
                ((exec_time_count++))
                exec_time_sum=$(awk "BEGIN {printf \"%.6f\", $exec_time_sum + $exec_time_value}")
                if [ -z "$exec_time_min" ] || awk "BEGIN {exit !($exec_time_value < $exec_time_min)}"; then
                    exec_time_min="$exec_time_value"
                fi
                if [ -z "$exec_time_max" ] || awk "BEGIN {exit !($exec_time_value > $exec_time_max)}"; then
                    exec_time_max="$exec_time_value"
                fi
            fi

            if echo "$output" | grep -q '"slots"'; then
                # Check for errors array
                if echo "$output" | grep -q '"errors"'; then
                    # Try to count errors (basic pattern matching)
                    # Look for error objects in the errors array
                    error_matches=$(echo "$output" | grep -o '"error"[[:space:]]*:' | wc -l | tr -d '[:space:]')
                    if [ "$error_matches" -gt 0 ] 2>/dev/null; then
                        call_has_errors=true
                        call_failed=true
                        error_count_in_call=$error_matches
                        ((total_error_count+=$error_count_in_call))
                        ((total_failure_count++))
                        
                        # Check for timeout patterns in error messages
                        # Look for "timeout", "Device timeout", or "not responding" in error messages
                        if echo "$output" | grep -qiE '"message"[[:space:]]*:[[:space:]]*"[^"]*(timeout|not responding)'; then
                            call_has_timeout=true
                            timeout_count_in_call=$(echo "$output" | grep -oiE '"message"[[:space:]]*:[[:space:]]*"[^"]*(timeout|not responding)' | wc -l | tr -d '[:space:]')
                            ((total_timeout_failure_count+=$timeout_count_in_call))
                        fi
                    else
                        # No errors found
                        ((total_success_count++))
                    fi
                else
                    # No errors array found - consider it successful
                    ((total_success_count++))
                fi
            else
                # No slots found - consider it a failure
                call_failed=true
                ((total_failure_count++))
            fi
        fi
    else
        # Exit code is non-zero - this is a failure
        echo "Error (exit code: $exit_code):"
        echo "$output"
        call_failed=true
        ((total_failure_count++))
        
        # Check if the error output contains timeout information
        if echo "$output" | grep -qiE "(timeout|not responding)"; then
            call_has_timeout=true
            ((total_timeout_failure_count++))
        fi
    fi
    
    # Print call summary
    if [ "$call_failed" = "true" ]; then
        echo "  [FAILED]"
        if [ "$call_has_timeout" = "true" ]; then
            echo "  -> Contains timeout errors ($timeout_count_in_call timeout(s))"
        fi
        if [ "$call_has_errors" = "true" ]; then
            echo "  -> Contains errors ($error_count_in_call error(s))"
        fi
    else
        echo "  [SUCCESS]"
    fi
    
    # Add delay between calls (except after the last one)
    if [ $i -lt $times ]; then
        delay_ms "$delay_ms_value"
    fi
    
    echo "" # Empty line for readability
done

echo "=========================================="
echo "Interrogation complete!"
echo "=========================================="

# BF-260510 validation: read the link telemetry now that the slot loop is
# done. retries vs final_failures tells us whether the protocol fix is
# carrying its weight or whether residual failures need a hardware
# investigation (see BF-260510.md, validation plan step 5).
echo ""
run_link_stats "$LINK_STATS_AFTER_FILE" "" "AFTER"

# Build the results log file (named with a timestamp so multiple runs don't overwrite each other)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$SCRIPT_DIR/interrogate_slots_all_results_${TIMESTAMP}.log"

{
    echo "Interrogation results - $(date)"
    echo "Platform: $platform"
    echo "Model: $model"
    echo "Calls: $times"
    echo "Delay: ${delay_ms_value}ms"
    echo ""
    echo "=========================================="
    echo "Overall Summary"
    echo "=========================================="
    echo "  Total calls: $times"
    echo "  Successful calls: $total_success_count"
    echo "  Failed calls: $total_failure_count"
    echo "  Total errors detected: $total_error_count"
    echo "  Total timeout errors: $total_timeout_failure_count"

    # Execution time metrics (computed across all calls that returned a parseable executionTimeMs)
    echo ""
    echo "=========================================="
    echo "Execution time metrics (executionTimeMs)"
    echo "=========================================="
    if [ "$exec_time_count" -gt 0 ]; then
        exec_time_avg=$(awk "BEGIN {printf \"%.3f\", $exec_time_sum / $exec_time_count}")
        echo "  Samples: $exec_time_count"
        echo "  Min: ${exec_time_min} ms"
        echo "  Max: ${exec_time_max} ms"
        echo "  Average (mean): ${exec_time_avg} ms"
    else
        echo "  No executionTimeMs values were captured."
    fi

    # Detailed failure breakdown (only when we have logged structured errors via jq)
    if [ -s "$ERRORS_FILE" ]; then
        echo ""
        echo "=========================================="
        echo "Failure breakdown"
        echo "=========================================="

        # Per-slot statistics: how many times each (boardAddress, slotIndex) failed
        echo ""
        echo "Failures per slot (boardAddress, slotIndex):"
        awk -F'|' '{print $1"|"$2}' "$ERRORS_FILE" \
            | sort \
            | uniq -c \
            | sort -rn \
            | awk '{
                count=$1
                $1=""
                sub(/^ /, "")
                split($0, a, "|")
                printf "  Board %s, Slot %s: %d failure(s)\n", a[1], a[2], count
            }'

        # Per-error-type statistics
        echo ""
        echo "Failures per error type:"
        awk -F'|' '{print $3}' "$ERRORS_FILE" \
            | sort \
            | uniq -c \
            | sort -rn \
            | awk '{
                count=$1
                $1=""
                sub(/^ /, "")
                printf "  %s: %d occurrence(s)\n", $0, count
            }'

        # Per-message statistics (helps distinguish "Device timeout" vs other messages)
        echo ""
        echo "Failures per message:"
        awk -F'|' '{print $4}' "$ERRORS_FILE" \
            | sort \
            | uniq -c \
            | sort -rn \
            | awk '{
                count=$1
                $1=""
                sub(/^ /, "")
                printf "  \"%s\": %d occurrence(s)\n", $0, count
            }'

        # All recorded failures in the requested object shape
        echo ""
        echo "All recorded failures:"
        awk -F'|' '{
            printf "{\n"
            printf "  \"index\": %s,\n", NR
            printf "  \"boardAddress\": %s,\n", ($1 == "N/A" ? "null" : $1)
            printf "  \"slotIndex\": %s,\n", ($2 == "N/A" ? "null" : $2)
            printf "  \"error\": \"%s\",\n", $3
            printf "  \"message\": \"%s\",\n", $4
            printf "  \"call\": %s\n", $5
            printf "}\n"
        }' "$ERRORS_FILE"
    fi

    # BF-260510 link telemetry snapshots. BEFORE shows the post-reset
    # state (sanity-checks that --reset took); AFTER shows what the
    # interface board observed across this run. Decision rule:
    #   retries >> final_failures  -> protocol fix is carrying its weight
    #   retries ~= final_failures  -> mechanical (see BF-260510.md step 5)
    echo ""
    echo "=========================================="
    echo "Link telemetry (BF-260510)"
    echo "=========================================="
    echo ""
    echo "[BEFORE — post-reset]"
    if [ -s "$LINK_STATS_BEFORE_FILE" ]; then
        cat "$LINK_STATS_BEFORE_FILE"
    else
        echo "  (no output captured)"
    fi
    echo ""
    echo "[AFTER — end of run]"
    if [ -s "$LINK_STATS_AFTER_FILE" ]; then
        cat "$LINK_STATS_AFTER_FILE"
    else
        echo "  (no output captured)"
    fi
} > "$LOG_FILE"

echo ""
echo "Results written to: $LOG_FILE"

