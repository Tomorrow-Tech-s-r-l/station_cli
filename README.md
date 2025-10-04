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

## Commands

### Get Slots Status
Retrieves the status of all slots across all boards, including powerbank information for available slots. The command will scan all boards (0-4) and all slots (0-5) on each board.

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

### Initialize Powerbank
Initializes a powerbank in a specific slot with default values. Currently uses a placeholder serial number (0000000000).

```bash
station-cli initialize-powerbank -b <board> -s <slot>
```

Options:
- `-b, --board <address>`: Board address (0-4) (required)
- `-s, --slot <index>`: Slot index (0-5) (required)

Output example:
```
Powerbank initialized
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