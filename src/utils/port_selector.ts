import { SerialPort } from "serialport";

export async function selectPort(): Promise<string> {
  const ports = await SerialPort.list().then((list: any[]) =>
    list.map((p: any) => p.path)
  );
  const filteredPorts = ports.filter(
    (p) =>
      p.includes("usbserial") || // generic substring
      p.includes("tty.usbserial") || // macOS
      p.includes("ttyUSB0") // Linux
  );
  if (filteredPorts.length === 0) {
    throw new Error("No compatible serial port found");
  }
  return filteredPorts[0];
}
