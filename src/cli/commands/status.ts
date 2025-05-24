import { BaseCommand } from "./base";
import {
  SerialMessage,
  CommandResponse,
  PowerbankInfo,
} from "../../protocol/types";
import { CMD_STATUS_CODE, MAXIMUM_SLOT_INDEX } from "../../protocol/constants";
import { Buffer } from "buffer";

export class StatusCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotIndex: number
  ): Promise<CommandResponse> {
    if (slotIndex < 0 || slotIndex > MAXIMUM_SLOT_INDEX) {
      throw new Error(`Slot index must be between 0 and ${MAXIMUM_SLOT_INDEX}`);
    }

    const message: SerialMessage = {
      boardAddress,
      command: CMD_STATUS_CODE,
      data: Buffer.from([slotIndex]),
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
