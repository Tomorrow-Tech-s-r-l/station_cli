# Station CLI

A command-line interface tool for controlling station boards and powerbanks. This tool provides a set of commands to manage powerbank stations, including slot management, powerbank status monitoring, and device initialization.

## Installation

The CLI can be installed in two ways:

### Global Installation (Recommended)
```bash
npm install -g station-cli
```

### Development Version
If you want to use the development version (pre-release builds), you can install it with:
```bash
npm install -g station-cli@dev
```

## Updates

The CLI automatically checks for updates when you run any command. By default, it will:
- Use production releases (stable versions)
- Automatically download and install updates
- Verify the downloaded binary
- Make the binary executable
- Handle platform-specific requirements (e.g., macOS quarantine attributes)

### Development Updates
If you installed the development version, the CLI will:
- Use pre-release builds from the development branch
- Update to the latest development version
- Tag development releases with `dev-v` prefix (e.g., `dev-v1.0.0`)

### Version Management
- Production releases are tagged with `v` prefix (e.g., `v1.0.0`)
- Development releases are tagged with `dev-v` prefix (e.g., `dev-v1.0.0`)
- The CLI will only update to releases matching your installation type (production or development)
- Version comparison is done using semantic versioning

### Update Process
1. The CLI checks for updates by querying GitHub releases
2. If a newer version is available:
   - Downloads the appropriate binary for your platform
   - Verifies the download
   - Makes the binary executable
   - Updates the local installation
3. If the update fails:
   - Keeps the existing version
   - Reports the error
   - Continues with the requested command

## Port Detection

The CLI automatically detects and connects to the appropriate serial port. It will:
- Scan for available serial ports
- Identify the correct port for the station board
- Handle port selection automatically
- Support multiple devices (if connected)

If multiple devices are connected, the CLI will use the first compatible device found.

## Logging

The CLI supports optional file logging to help with debugging and record-keeping. When enabled, all terminal output (including commands, responses, and errors) will be saved to a timestamped log file.

### Enabling Logging

To enable logging, add the `--log` flag to any command:

```bash
station-cli --log slots
station-cli --log unlock -i 1
station-cli --log status -b 0 -s 0
```

### Log File Format

When logging is enabled:
- A log file is created with the format: `YYYY-MM-DDTHH-MM-SS-cli-logs.log`
- The file is created in the current working directory
- Each log entry includes a timestamp and log level (`[LOG]` or `[ERROR]`)
- The log file includes a header and footer with session timestamps

Example log file name: `2025-10-08T14-30-45-cli-logs.log`

Example log file content:
```
=== CLI Log Started at 2025-10-08T14:30:45.123Z ===
[LOG] 2025-10-08T14:30:45.123Z - Logging enabled. Log file: /path/to/2025-10-08T14-30-45-cli-logs.log
[LOG] 2025-10-08T14:30:46.456Z - {"success":true,"executionTimeMs":123,...}
[ERROR] 2025-10-08T14:30:50.789Z - Error: Connection failed
=== CLI Log Ended at 2025-10-08T14:30:51.000Z ===
```

### Default Behavior

- **Default:** Logging is **disabled** by default
- **Terminal output:** Always displayed, regardless of logging setting
- **Performance:** Minimal overhead when logging is enabled

### Debug Messages

Serial communication debug messages can be enabled by setting the `DEBUG=true` environment variable:

```bash
DEBUG=true station-cli --log slots
```

When both `DEBUG=true` and `--log` are enabled, the log file will include:
- Command requests and responses
- Serial frame data (TX/RX)
- Hex dumps of raw data
- Connection status messages
- CRC validation details
- All other debug information

#### Enhanced Slot Request Logging

When debug mode is enabled, each slot request is now clearly separated and includes detailed information:

**Console Output (with colors):**
- Magenta separator lines mark the start and end of each slot request
- Yellow payload data showing the exact bytes sent
- Cyan response data with color-coded status (green for success, red for failure)
- Hex-formatted data for easy debugging

**Log File Output:**
Each slot request includes:
1. **Request Header**: Shows the command name, board address, and slot index
2. **Payload Information**: The exact command buffer being sent (in hex format)
3. **Transport Frame**: The complete serial frame with CRC (TX/RX)
4. **Response Data**: Full response with status code and payload data
5. **Request Footer**: Clear end marker for the request

Example debug log entries:
```
[LOG] 2025-10-18T14:30:45.123Z - [DEBUG INFO] Connecting to port: /dev/ttyUSB0 at 115200 baud

[LOG] 2025-10-18T14:30:45.234Z - 
================================================================================
[LOG] 2025-10-18T14:30:45.234Z - [SLOT REQUEST START] STATUS - Board 0 Slot 0
[LOG] 2025-10-18T14:30:45.234Z - ================================================================================
[LOG] 2025-10-18T14:30:45.235Z - [DEBUG INFO] Sending message: { boardAddress: 0, command: 1, dataLength: 1 }
[LOG] 2025-10-18T14:30:45.236Z - [PAYLOAD Command Buffer] 00 01 00
[LOG] 2025-10-18T14:30:45.237Z - [DEBUG HEX] Calculated CRC16: a3b4
[LOG] 2025-10-18T14:30:45.238Z - [DEBUG FRAME TX] ea 00 01 00 a3 b4
[LOG] 2025-10-18T14:30:45.345Z - [DEBUG HEX] Received raw data: ea 01 00 31 32 33 34 35 36 37 38 39 30 c5 d6
[LOG] 2025-10-18T14:30:45.346Z - [RESPONSE Full Response] Status: 0 Data: 01 00 31 32 33 34 35 36 37 38 39 30
[LOG] 2025-10-18T14:30:45.347Z - [DEBUG HEX] Response Payload: 31 32 33 34 35 36 37 38 39 30
[LOG] 2025-10-18T14:30:45.348Z - [SLOT REQUEST END] ================================================================================
```

This enhanced logging makes it much easier to:
- Track individual slot operations in complex sequences
- Debug communication issues with specific slots
- Verify the exact data being sent and received
- Correlate requests with responses
- Identify which slot requests are failing or timing out

## Commands

### Get Slots Status
Retrieves the status of all slots across all boards, including powerbank information for available slots. The command will scan all boards (0-4) and all slots (0-5) on each board.

**Automatic Charging Management:** This command also actively manages charging by enabling charging for powerbanks that need it (power level < 95%). Only ONE powerbank per board can charge at a time - the first powerbank found that needs charging will be selected and enabled, while others are disabled.

```bash
station-cli slots
```

Output example:
```json
{
  "slots": [
    {
      "powerBank": {
        "id": "1234567890",
        "powerLevel": 80
      },
      "isCharging": false,
      "isLocked": true,
      "index": 1,
      "state": "available",
      "disabled": false,
      "boardAddress": 0,
      "slotIndex": 0
    }
  ],
  "errors": [
    {
      "index": -1,
      "boardAddress": 1,
      "slotIndex": -1,
      "error": "slots_command_failed",
      "message": "Device timeout - device not responding"
    }
  ],
  "executionTimeMs": 1234,
  "timestamp": "2024-03-21T10:30:45.123Z"
}
```

Note: The command includes a small delay (100ms) between status checks to avoid race conditions.

### Unlock Slot
Unlocks a specific slot to allow powerbank removal. The slot index is automatically mapped to the correct board and slot.

```bash
station-cli unlock -i <index>
```

Options:
- `-i, --index <index>`: Slot index (1-30) (required)

Slot to board mapping:
- Slots 1-6   → Board 0, Slots 0-5
- Slots 7-12  → Board 1, Slots 0-5
- Slots 13-18 → Board 2, Slots 0-5
- Slots 19-24 → Board 3, Slots 0-5
- Slots 25-30 → Board 4, Slots 0-5

Output example:
```json
{
  "success": true,
  "executionTimeMs": 123,
  "timestamp": "2024-03-21T10:30:45.123Z",
  "slotIndex": 30,
  "boardAddress": 4,
  "slotInBoard": 5,
  "error": null
}
```

### Enable/Disable Charging
The `charge` command allows you to enable or disable charging for a specific slot. This is useful for managing power consumption or when you need to stop charging a powerbank.

```bash
# Enable charging for slot 1
station-cli charge -i 1 -e true

# Disable charging for slot 30
station-cli charge -i 30 -e false
```

Options:
- `-i, --index <index>`: Slot index (1-30) (required)
- `-e, --enable <enable>`: Enable charging (true/false) (required)

Output example:
```json
{
  "success": true,
  "executionTimeMs": 123,
  "timestamp": "2024-03-21T10:30:45.123Z",
  "slotIndex": 1,
  "boardAddress": 0,
  "slotInBoard": 0,
  "chargingEnabled": true,
  "error": null
}
```

### Initialize Powerbank
Initializes a powerbank in a specific slot with ID and battery gauge information. This command writes the powerbank's identification and battery management system (BMS) data to the device.

**Important:** This command only writes metadata/configuration to the device - it does not physically charge the battery. To charge the powerbank, use the `charge` command separately.

```bash
station-cli initialize-powerbank -i <index> --id <serialNumber> [options]
```

Options:
- `-i, --index <index>`: Slot index (1-30) (required)
- `--id <serialNumber>`: Powerbank serial number - exactly 10 characters (required)
- `--total-charge <mAh>`: Total battery capacity in mAh (default: 13925, max: 65535)
- `--current-charge <mAh>`: Current battery charge level in mAh (default: 11625, max: 65535)
- `--cutoff-charge <mAh>`: Cutoff battery charge in mAh (default: 10625, max: 65535)
- `--cycles <count>`: Battery cycle count (default: 0, max: 65535)

**What this command does:**
1. **Set Powerbank Info (opcode 0x08)**: Writes the serial number, manufacturing timestamp (automatically set to current time), and cycle count to the device's memory
2. **Set Battery Gauge Info (opcode 0x09)**: Writes the battery capacity, current charge level, and cutoff charge values to the battery management system

These values are used by the device to:
- Track and display the powerbank's charge level
- Identify the specific powerbank unit
- Monitor battery health and cycle count
- Determine when to stop charging (cutoff level)

Examples:
```bash
# Basic initialization with required parameters only (uses defaults)
station-cli initialize-powerbank -i 1 --id ABC1234567

# Full initialization with custom battery parameters
station-cli initialize-powerbank -i 1 --id ABC1234567 --total-charge 15000 --current-charge 12000 --cutoff-charge 11000 --cycles 5
```

Output example (success):
```json
{
  "success": true,
  "executionTimeMs": 245,
  "timestamp": "2024-03-21T10:30:45.123Z",
  "slotIndex": 1,
  "boardAddress": 0,
  "slotInBoard": 0,
  "powerbank": {
    "serialNumber": "ABC1234567",
    "manufacturingTimestamp": 1710931845,
    "cycles": 0,
    "totalCharge": 13925,
    "currentCharge": 11625,
    "cutoffCharge": 10625
  }
}
```

Output example (failure):
```json
{
  "success": false,
  "executionTimeMs": 123,
  "timestamp": "2024-03-21T10:30:45.123Z",
  "slotIndex": 1,
  "boardAddress": 0,
  "slotInBoard": 0,
  "error": {
    "code": 4,
    "message": "Internal device error - device may need reset"
  }
}
```

Note: The serial number must be exactly 10 characters. If your ID is shorter, pad it with leading zeros or other characters.


## Debug Commands

The following commands are intended for development and troubleshooting purposes. They provide low-level access to device functionality and should be used with caution.

### Get Powerbank Status
Retrieves detailed information about a powerbank in a specific slot, including power level calculation.

```bash
station-cli status -b <board> -s <slot>
```

Options:
- `-b, --board <address>`: Board address (0-4) (required)
- `-s, --slot <index>`: Slot index (0-5) (required)

Output example:
```json
{
  "success": true,
  "executionTimeMs": 123,
  "timestamp": "2024-03-21T10:30:45.123Z",
  "serial": "1234567890",
  "manufTs": "2024-03-21T10:30:45.123Z",
  "totalCharge": "100",
  "currentCharge": "80",
  "cutoffCharge": "20",
  "cycles": 5,
  "pbStatus": 1,
  "powerLevel": 80
}
```

If the command fails with an internal error, the CLI will suggest possible solutions:
1. Try resetting the device
2. Check if the powerbank is properly inserted
3. Try a different slot

### Get Firmware Version
Retrieves the firmware version of a specific board.

```bash
station-cli firmware -b <board>
```

Options:
- `-b, --board <address>`: Board address (0-4) (required)

Output example:
```
Firmware version: 1.2.3
```

## Error Handling

The CLI provides detailed error information in JSON format when operations fail. Common error types include:

- `slots_command_failed`: Failed to get slots information
- `status_command_failed`: Failed to get powerbank status
- `invalid_response`: Failed to parse response data
- `connection_error`: Communication error with the device
- `internal_error`: Internal device error

Each error includes:
- Error code
- Descriptive message
- Board address and slot index (where applicable)
- Timestamp
- Execution time

## Error Reference

This section provides a complete reference of all errors that can occur when using the Station CLI.

### Device Status Codes

These are status codes returned by the station board firmware in response to commands:

| Code | Name | Message | Description |
|------|------|---------|-------------|
| `0x00` | `STATUS_OK` | Command successful | The command executed successfully |
| `0x01` | `STATUS_TIMEOUT` | Device timeout - device not responding | The device did not respond within the expected time frame |
| `0x02` | `STATUS_ERR_INVALID_CMD` | Invalid command - command not supported | The command code is not recognized by the device |
| `0x03` | `STATUS_ERR_INVALID_ARGS` | Invalid arguments - check command parameters | The command arguments are invalid or out of range |
| `0x04` | `STATUS_ERR_INTERNAL` | Internal device error - device may need reset | An internal error occurred in the device firmware |
| `0x80` | `STATUS_ERR_INVALID_RESPONSE` | Invalid response format from device | The response from the device could not be parsed |

### Slot Error Types

These errors are generated by the CLI when interacting with slots:

| Error Code | Description | Typical Causes |
|------------|-------------|----------------|
| `status_command_failed` | Failed to retrieve powerbank status from a slot | - Powerbank not properly inserted<br>- Device communication timeout<br>- Slot hardware malfunction |
| `slots_command_failed` | Failed to get status information for all slots on a board | - Board not responding<br>- Communication timeout<br>- Board not powered |
| `invalid_response` | Failed to parse the response data from the device | - Corrupted data transmission<br>- Protocol mismatch<br>- Invalid data format |
| `connection_error` | Unable to communicate with the device | - Board not connected<br>- Serial port issues<br>- Cable disconnected |

### Input Validation Errors

These errors occur when command arguments don't meet the required criteria:

| Validation | Error Message | Valid Range/Values |
|------------|---------------|-------------------|
| Slot Index | `Index value must be between minimum 1 and maximum 30` | 1-30 (maps to boards 0-4, slots 0-5) |
| Board Address | `Board address must be between 0 and 4` | 0-4 |
| Slot Address | `Slot index must be between 0 and 5` | 0-5 |
| Enable Flag | `Enable value must be either "true" or "false"` | `true` or `false` |
| Power Level | `Power level must be between 0 and 100` | 0-100 |

### Serial Connection Errors

These errors occur during serial port connection and communication:

| Error Type | Message | Possible Solutions |
|------------|---------|-------------------|
| No Ports Found | `No serial ports found!` | 1. Check if device is connected<br>2. Install correct drivers<br>3. Ensure device is powered on |
| Connection Failed | `Failed to connect to port` | 1. Close other programs using the port<br>2. Check user permissions<br>3. Verify device connection |
| Port Not Connected | `Serial port is not connected` | 1. Ensure device is properly connected<br>2. Verify correct port is selected<br>3. Check if another program is using the port |
| Command Timeout | `Command timed out` | 1. Device may not be responding<br>2. Device might be busy with another command<br>3. Connection may be unstable<br>4. Try again or check device connection |
| Port Not Initialized | `Port not initialized` | Internal error - restart the CLI |

### Command-Specific Error Scenarios

#### Status Command (`station-cli status`)

When the status command fails with `STATUS_ERR_INTERNAL`, the CLI suggests:
1. Try resetting the device
2. Check if the powerbank is properly inserted
3. Try a different slot

#### Slots Command (`station-cli slots`)

The slots command may return partial results with an `errors` array containing information about boards that failed to respond:

```json
{
  "slots": [...],
  "errors": [
    {
      "index": -1,
      "boardAddress": 1,
      "slotIndex": -1,
      "error": "slots_command_failed",
      "message": "Device timeout - device not responding"
    }
  ],
  "executionTimeMs": 1234,
  "timestamp": "2024-03-21T10:30:45.123Z"
}
```

### Error Response Format

When a command fails, the CLI returns a JSON response with the following structure:

```json
{
  "success": false,
  "executionTimeMs": 123,
  "timestamp": "2024-03-21T10:30:45.123Z",
  "error": {
    "code": -1,
    "message": "Error description"
  }
}
```

For slot-specific commands (unlock, charge), additional fields include:
- `slotIndex`: The requested slot index (1-30)
- `boardAddress`: The calculated board address (0-4)
- `slotInBoard`: The calculated slot within the board (0-5)

### Troubleshooting Guide

#### Device Not Responding
**Symptoms:** Timeout errors, connection errors
**Solutions:**
1. Check physical connection
2. Verify device is powered on
3. Try disconnecting and reconnecting the device
4. Restart the CLI
5. Check if another program is using the serial port

#### Internal Device Errors
**Symptoms:** `STATUS_ERR_INTERNAL` (0x04)
**Solutions:**
1. Power cycle the device
2. Check powerbank insertion
3. Try a different slot
4. Update device firmware if available

#### Communication Issues
**Symptoms:** `invalid_response`, `connection_error`
**Solutions:**
1. Check cable quality and connections
2. Verify correct serial port selection
3. Ensure proper baud rate (115200)
4. Check for electromagnetic interference

#### Validation Errors
**Symptoms:** Input validation error messages
**Solutions:**
1. Verify command syntax matches documentation
2. Check argument ranges (slots 1-30, boards 0-4, etc.)
3. Use correct data types (integers for indices, boolean strings for flags)

## Response Format

All commands that return data use a consistent JSON format with:
- `success`: Boolean indicating operation success
- `executionTimeMs`: Operation execution time in milliseconds
- `timestamp`: ISO timestamp of the operation
- Command-specific data
- Error information (if applicable)

## Exit Codes

- `0`: Success
- `1`: Error (with error details in the response)

## Platform Support

The CLI is available for:
- Linux (ARM64)
- macOS (ARM64)

Each platform has its own binary, and the updater will automatically download the correct version for your system.

## Development

If you're interested in contributing to the CLI:

1. Clone the repository
2. Install dependencies: `npm install`
3. Build the project: `npm run build`
4. Run tests: `npm test`

The project uses:
- TypeScript for type safety
- Commander.js for CLI interface
- GitHub Actions for CI/CD
- Semantic versioning for releases

Development builds are automatically created when pushing to the `development` branch, while production releases are created when pushing to the `main` branch.