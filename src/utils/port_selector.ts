import { SerialPort } from "serialport";
import { getModel } from "./model";

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

export async function selectPorts(): Promise<[string, string]> {
  const model = getModel();
  if (model !== "S0RU30") {
    throw new Error("selectPorts() is only for S0RU30 model");
  }

  const ports = await SerialPort.list().then((list: any[]) =>
    list.map((p: any) => p.path)
  );
  const filteredPorts = ports.filter(
    (p) =>
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
