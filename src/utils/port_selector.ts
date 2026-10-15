import { SerialPort } from "serialport";

/** The subset of `SerialPort.list()` entries the selector looks at. */
export interface PortCandidate {
  path: string;
  manufacturer?: string;
  pnpId?: string;
  vendorId?: string;
  productId?: string;
}

/**
 * USB identity of the Amperry hardware station emulator (an Arduino UNO Q
 * presenting itself as a USB serial gadget — see
 * team-app/station_emulator/hwbox). It enumerates as a CDC-ACM device
 * (`/dev/ttyACM*`), which the generic rules below deliberately ignore: on a
 * real station any modem or gadget could be an ACM port. The emulator is
 * therefore matched by its USB strings, never by the device name alone.
 */
export const EMULATOR_USB_MANUFACTURER = "Amperry";
export const EMULATOR_USB_PRODUCT = "Station Emulator";

export function isStationEmulator(p: PortCandidate): boolean {
  const manufacturer = (p.manufacturer ?? "").toLowerCase();
  const pnpId = (p.pnpId ?? "").toLowerCase();
  return (
    manufacturer.includes(EMULATOR_USB_MANUFACTURER.toLowerCase()) ||
    pnpId.includes("amperry_station_emulator")
  );
}

function isGenericStationPort(path: string): boolean {
  return (
    /^COM\d+$/i.test(path) || // Windows
    path.includes("usbserial") || // generic substring
    path.includes("tty.usbserial") || // macOS
    path.includes("ttyUSB0") // Linux
  );
}

/**
 * Picks the station port from an enumeration: the real interfacer bus (an
 * FTDI / USB-RS485 adapter) first, exactly as before; the hardware emulator
 * only when no real bus is attached, so plugging the emulator into a real
 * station can never hijack it.
 */
export function pickPort(ports: PortCandidate[]): string | undefined {
  const real = ports.find((p) => isGenericStationPort(p.path));
  if (real) return real.path;
  return ports.find(isStationEmulator)?.path;
}

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

  const ports: PortCandidate[] = await SerialPort.list();
  const port = pickPort(ports);
  if (!port) {
    throw new Error("No compatible serial port found");
  }
  return port;
}
