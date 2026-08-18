import { SerialPort } from "serialport";

export async function selectPort(): Promise<string> {
  // Test/emulator seam: when STATION_CLI_PORT is set, use it verbatim and skip
  // USB enumeration. This lets the unmodified CLI open a virtual serial port
  // (e.g. a socat PTY bridged to the station_emulator) so every layer below —
  // serialport open, framing, CRC, retries — runs for real against emulated
  // hardware. Mirrors the kiosk's KIOSK_WS_URL_OVERRIDE seam.
  const override = process.env.STATION_CLI_PORT;
  if (override && override.length > 0) {
    return override;
  }

  const ports = await SerialPort.list().then((list: any[]) =>
    list.map((p: any) => p.path)
  );
  const filteredPorts = ports.filter(
    (p) =>
      /^COM\d+$/i.test(p) || // Windows
      p.includes("usbserial") || // generic substring
      p.includes("tty.usbserial") || // macOS
      p.includes("ttyUSB0") // Linux
  );
  if (filteredPorts.length === 0) {
    throw new Error("No compatible serial port found");
  }
  return filteredPorts[0];
}
