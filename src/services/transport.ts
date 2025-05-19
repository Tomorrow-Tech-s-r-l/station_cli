import { Buffer } from "buffer";
import { debug } from "../utils/debug";
import { crc16 } from "easy-crc";
import {
  FRAME_START_BYTE,
  FRAME_RECEIVE_DELAY_MS,
  CRC_ALGORITHM,
} from "../protocol/constants";

export class TransportProtocol {
  static buildFrame(payload: Buffer): Buffer {
    // Calculate CRC16 of address + payload
    const crc = crc16(CRC_ALGORITHM, payload);
    debug.log("Calculated CRC16:", crc.toString(16));

    // Build frame: <SF> <address + payload> <CRC16>
    const frame = Buffer.alloc(payload.length + 3);
    frame.writeUInt8(FRAME_START_BYTE, 0);
    payload.copy(frame, 1);
    frame.writeUInt16LE(crc, payload.length + 1); // MODBUS uses little-endian

    debug.log("Built frame:", frame.toString("hex"));
    return frame;
  }

  static parseFrame(frame: Buffer): Buffer | null {
    if (frame.length < 4) {
      debug.error("Frame too short:", frame.toString("hex"));
      return null;
    }

    // Verify start frame
    const startFrame = frame.readUInt8(0);
    if (startFrame !== FRAME_START_BYTE) {
      debug.error("Invalid start frame:", startFrame.toString(16));
      return null;
    }

    // Extract payload and CRC
    const payload = frame.slice(1, -2);
    const receivedCrc = frame.readUInt16LE(frame.length - 2); // MODBUS uses little-endian

    // Calculate CRC of payload
    const calculatedCrc = crc16(CRC_ALGORITHM, payload);
    debug.log("Received CRC16:", receivedCrc.toString(16));
    debug.log("Calculated CRC16:", calculatedCrc.toString(16));

    // Verify CRC
    if (receivedCrc !== calculatedCrc) {
      debug.error("CRC mismatch");
      return null;
    }

    debug.log("Successfully parsed frame");
    return payload;
  }

  static async waitForFrameReceive(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, FRAME_RECEIVE_DELAY_MS));
  }
}
