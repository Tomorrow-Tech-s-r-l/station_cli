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
 * Windows lists every COM port, including ones that can never be the
 * station: the motherboard UART (COM1, pnpId "ACPI\PNP0501\...") and
 * Bluetooth serial links (pnpId "BTHENUM\..."). Their identity is known, so
 * they are ruled out instead of being picked just because they come first.
 */
export function isNonUsbComPort(p: PortCandidate): boolean {
  const pnpId = (p.pnpId ?? "").toUpperCase();
  return pnpId.startsWith("ACPI\\") || pnpId.includes("BTHENUM");
}

/**
 * Picks the station port from an enumeration: the real interfacer bus (an
 * FTDI / USB-RS485 adapter) first; among several candidates one that reports
 * a USB vendor id wins, so a stray built-in or Bluetooth COM port on Windows
 * cannot shadow the adapter. The hardware emulator is used only when no real
 * bus is attached, so plugging the emulator into a real station can never
 * hijack it.
 */
export function pickPort(ports: PortCandidate[]): string | undefined {
  const real = ports.filter((p) => isGenericStationPort(p.path) && !isNonUsbComPort(p));
  const best = real.find((p) => p.vendorId !== undefined && p.vendorId !== "") ?? real[0];
  if (best) return best.path;
  return ports.find(isStationEmulator)?.path;
}

let portOverride: string | undefined;

/** Port given on the command line (-p/--port); wins over STATION_CLI_PORT. */
export function setPortOverride(port: string | undefined): void {
  portOverride = port;
}

export async function selectPort(): Promise<string> {
  if (portOverride && portOverride.length > 0) {
    return portOverride;
  }

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
    const seen = ports.map((p) => p.path).join(", ") || "none";
    throw new Error(
      `No compatible serial port found (available: ${seen}). ` +
        `Run "station-cli ports" and pass the station port with --port, e.g. --port COM3`
    );
  }
  return port;
}
