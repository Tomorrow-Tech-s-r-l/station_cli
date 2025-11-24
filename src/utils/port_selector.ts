import { SerialService } from "../S1TTXX/services/serial";

export async function selectPort(): Promise<string> {
  const service = new SerialService("");
  const ports = await service.listPorts();
  const filteredPorts = ports.filter(
    (p) => p.includes("usbserial") || p.includes("ttyUSB0")
  );
  return filteredPorts[0];
}
