# Interfacer core cli

CLI tool to control station board and powerbanks via serial interface.

## Installation

## Usage

1. Install via npm:
   ```bash
   npm install -g interfacer-core-cli
   ```

2. Run commands:
   ```bash
   # List available ports
   ./dist/cli.js list-ports

   # Get powerbank status
   ./dist/cli.js status -p /dev/tty.usbserial-BG02020H -b 0 -s 1

   # Get all slots status
   ./dist/cli.js slots -p /dev/tty.usbserial-BG02020H -b 0
   ```

## Debug Mode

To enable debug output, set the `DEBUG` environment variable to `true`. This will show detailed communication logs with color coding:

```bash
# Enable debug mode
DEBUG=true ./dist/cli.js status -p /dev/tty.usbserial-BG02020H -b 0 -s 1
```

Debug output includes:
- 🔵 Blue: General debug info
- 🟢 Green: Success messages and transmitted frames
- 🔴 Red: Error messages
- 🟡 Yellow: Warning messages
- 🟣 Magenta: Hex data
- 🔷 Cyan: Info messages

Example debug output:
```
[DEBUG INFO] Initializing SerialService with port: /dev/tty.usbserial-BG02020H
[DEBUG INFO] Connecting to port: /dev/tty.usbserial-BG02020H at 115200 baud
[DEBUG SUCCESS] Port connected successfully
[DEBUG FRAME TX] ea 00 05 c1 b3
[DEBUG HEX] Received raw data: ea 00 05 00 ff fe e4 bc
[DEBUG SUCCESS] Successfully parsed response frame: 00 05 00 ff fe
```