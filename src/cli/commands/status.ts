import { BaseCommand } from "./base";
import {
  SerialMessage,
  CommandResponse,
  PowerbankInfo,
} from "../../protocol/types";
import {
  CMD_STATUS_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../protocol/constants";
// Buffer is a Node.js built-in, no import needed

export class StatusCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number
  ): Promise<CommandResponse> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new Error(
        `Slot index must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }

    const message: SerialMessage = {
      boardAddress,
      command: CMD_STATUS_CODE,
      data: Buffer.from([slotAddress]),
    };

    const response = await this.executeCommand(message);
    if (response.success && response.data.length >= 19) {
      // Parse powerbank info from response data
      const info: PowerbankInfo = {
        serial: response.data
          .subarray(0, 10)
          .toString("utf8")
          .trim()
          .replace(/\0/g, ""),
        timestamp: response.data.readUInt32LE(10),
        totalCharge: response.data.readUInt16LE(14),
        currentCharge: response.data.readUInt16LE(16),
        cutoffCharge: response.data.readUInt16LE(18),
        cycles: response.data.readUInt16LE(20),
        status: response.data.readUInt8(22),
      };
      return { ...response, data: Buffer.from(JSON.stringify(info)) };
    }
    return response;
  }
}
