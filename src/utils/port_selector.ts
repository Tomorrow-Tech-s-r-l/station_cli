import { SerialPort } from "serialport";
import { getModel } from "./model";

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

export async function selectPorts(): Promise<[string, string]> {
  const model = getModel();
  if (model !== "S0RU30") {
    throw new Error("selectPorts() is only for S0RU30 model");
  }

  // Emulator seam (see selectPort): "PORT_A,PORT_B" forces both board ports.
  const override = process.env.STATION_CLI_PORT;
  if (override && override.includes(",")) {
    const [a, b] = override.split(",").map((s) => s.trim());
    if (a && b) return [a, b];
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
  
  if (filteredPorts.length < 2) {
    throw new Error(
      `S0RU30 requires 2 serial ports, but only found ${filteredPorts.length} compatible port(s)`
    );
  }

  // Return first two ports
  // Board 0 (slots 1-18) uses first port
  // Board 1 (slots 19-30) uses second port
  return [filteredPorts[0], filteredPorts[1]];
}
