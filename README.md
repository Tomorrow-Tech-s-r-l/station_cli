# Station CLI

A command-line interface tool for controlling station boards and powerbanks. This tool provides a set of commands to manage powerbank stations, including slot management, powerbank status monitoring, and device initialization.

## Installation

```bash
npm install -g station-cli
```

## Commands

### List Available Ports
Lists all available serial ports on your system.

```bash
station-cli list-ports
```

Output example:
```
Available ports:
- /dev/tty.usbserial-0001
- /dev/tty.usbserial-0002
```

### Get Slots Status
Retrieves the status of all slots across all boards, including powerbank information for available slots.

```bash
station-cli slots -p <port>
```

Options:
- `-p, --port <path>`: Serial port path (required)

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
      "boardAddress": 1,
      "slotIndex": 2,
      "error": "status_command_failed",
      "message": "Device timeout - device not responding"
    }
  ],
  "executionTimeMs": 1234,
  "timestamp": "2024-03-21T10:30:45.123Z"
}
```

### Unlock Slot
Unlocks a specific slot to allow powerbank removal.

```bash
station-cli unlock -p <port> -i <index>
```

Options:
- `-p, --port <path>`: Serial port path (required)
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

### Get Powerbank Status
Retrieves detailed information about a powerbank in a specific slot.

```bash
station-cli status -p <port> -b <board> -s <slot>
```

Options:
- `-p, --port <path>`: Serial port path (required)
- `-b, --board <address>`: Board address (0-4) (required)
- `-s, --slot <index>`: Slot index (0-5) (required)

Output example:
```json
{
  "serial": "1234567890",
  "manufTs": "2024-03-21T10:30:45.123Z",
  "totalCharge": "100",
  "currentCharge": "80",
  "cutoffCharge": "20",
  "cycles": 5,
  "pbStatus": 1
}
```

### Get Firmware Version
Retrieves the firmware version of a specific board.

```bash
station-cli firmware -p <port> -b <board>
```

Options:
- `-p, --port <path>`: Serial port path (required)
- `-b, --board <address>`: Board address (0-4) (required)

Output example:
```
Firmware version: 1.2.3
```

### Initialize Powerbank
Initializes a powerbank in a specific slot with default values.

```bash
station-cli initialize-powerbank -p <port> -b <board> -s <slot>
```

Options:
- `-p, --port <path>`: Serial port path (required)
- `-b, --board <address>`: Board address (0-4) (required)
- `-s, --slot <index>`: Slot index (0-5) (required)

Output example:
```
Powerbank initialized
```

### Enable/Disable Charging

The `charge` command allows you to enable or disable charging for a specific slot. This is useful for managing power consumption or when you need to stop charging a powerbank.

### Command Usage

```bash
# Enable charging for slot 1
station-cli charge -p /dev/tty.usbserial-0001 -i 1 -e true

# Disable charging for slot 30
station-cli charge -p /dev/tty.usbserial-0001 -i 30 -e false
```

### Options

- `-p, --port <path>`: Serial port path (required)
- `-i, --index <index>`: Slot index (1-30) (required)
- `-e, --enable <enable>`: Enable charging (true/false) (required)

### Slot Mapping

The slots are mapped to boards as follows:
- Slots 1-6   → Board 0, Slots 0-5
- Slots 7-12  → Board 1, Slots 0-5
- Slots 13-18 → Board 2, Slots 0-5
- Slots 19-24 → Board 3, Slots 0-5
- Slots 25-30 → Board 4, Slots 0-5

For example:
- Slot 1  → Board 0, Slot 0
- Slot 7  → Board 1, Slot 0
- Slot 30 → Board 4, Slot 5

### Response Format

The command returns a JSON response with the following structure:

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

In case of an error:

```json
{
  "success": false,
  "executionTimeMs": 123,
  "timestamp": "2024-03-21T10:30:45.123Z",
  "slotIndex": 1,
  "boardAddress": 0,
  "slotInBoard": 0,
  "chargingEnabled": true,
  "error": {
    "code": 2,
    "message": "Invalid arguments - check command parameters"
  }
}
```

### Response Fields

- `success`: Boolean indicating if the command was successful
- `executionTimeMs`: Time taken to execute the command in milliseconds
- `timestamp`: ISO timestamp of when the command was executed
- `slotIndex`: The 1-based slot index (1-30)
- `boardAddress`: The board address (0-4)
- `slotInBoard`: The slot position within the board (0-5)
- `chargingEnabled`: Boolean indicating if charging was enabled or disabled
- `error`: Error information if the command failed, null if successful
  - `code`: Error code
  - `message`: Human-readable error message

### Error Codes

- `-1`: Unknown error (e.g., connection issues)
- `0`: Command successful
- `1`: Device timeout - device not responding
- `2`: Invalid command - command not supported
- `3`: Invalid arguments - check command parameters
- `4`: Internal device error - device may need reset
- `5`: Invalid response format from device

## Error Handling

The CLI provides detailed error information in JSON format when operations fail. Common error types include:

- `status_command_failed`: Command execution failed on the device
- `invalid_response`: Invalid response format from device
- `connection_error`: Communication error with the device
- `internal_error`: Internal device error

Each error includes:
- Error code
- Descriptive message
- Board address and slot index (where applicable)
- Timestamp
- Execution time

## Response Format

All commands that return data use a consistent JSON format with:
- `success`: Boolean indicating operation success
- `executionTimeMs`: Operation execution time in milliseconds
- `timestamp`: ISO timestamp of the operation
- Command-specific data
- Error information (if applicable)

## Debug Commands

Some commands are marked as debug commands and are intended for development and troubleshooting purposes. These commands provide low-level access to device functionality and should be used with caution.

## Exit Codes

- `0`: Success
- `1`: Error (with error details in the response)