# Station CLI

CLI tool to control station board and powerbanks via serial interface.

## Installation

There are two ways to use the CLI tool:

### Development (Node.js)

For development and debugging purposes, you can run the CLI directly with Node.js:

1. Clone and install locally:
   ```bash
   # Clone the repository
   git clone https://github.com/your-org/station-cli.git
   cd station-cli

   # Install dependencies
   npm install

   # Build the project
   npm run build
   ```

2. Run commands:
   ```bash
   # From the project directory
   ./dist/cli.js <command> [options]
   ```

### Production (Standalone Executable)

For production use on Raspberry Pi, the CLI is distributed as a standalone ARM executable:

1. Build the executable (requires Docker):
   ```bash
   # Make sure Docker is installed and running
   # Then run the build command
   npm run build:executable
   ```

   This will create an executable in the `dist` directory:
   - `station-cli-linux-arm` (for Raspberry Pi)

   Note: The build process uses Docker to create the ARM executable, as cross-compilation for ARM requires a Linux environment.

2. Install on Raspberry Pi:
   ```bash
   # Copy the executable to your Raspberry Pi
   scp dist/station-cli-linux-arm pi@your-raspberry-pi:/tmp/station-cli

   # SSH into your Raspberry Pi
   ssh pi@your-raspberry-pi

   # Make the executable available system-wide
   sudo mv /tmp/station-cli /usr/local/bin/station-cli
   sudo chmod +x /usr/local/bin/station-cli
   ```

## Usage

Available commands:

```bash
# List all available serial ports
station-cli list-ports

# Get status of a specific powerbank
station-cli status -p <port> -b <board> -s <slot>
# Example:
station-cli status -p /dev/tty.usbserial-BG02020H -b 0 -s 1

# Get status of all slots on a board
station-cli slots -p <port> -b <board>
# Example:
station-cli slots -p /dev/tty.usbserial-BG02020H -b 0
```

Command options:
- `-p, --port`: Serial port path (required)
- `-b, --board`: Board number (required)
- `-s, --slot`: Slot number (required for status command)
- `-h, --help`: Show help information

### Executable Usage Examples

```bash
# List available ports
station-cli list-ports

# Get powerbank status
station-cli status -p /dev/tty.usbserial-BG02020H -b 0 -s 1

# Get all slots status
station-cli slots -p /dev/tty.usbserial-BG02020H -b 0
```

## Debug Mode

Debug mode is primarily intended for development use with Node.js. To enable debug output, set the `DEBUG` environment variable to `true`:

```bash
# Enable debug mode (Node.js development only)
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