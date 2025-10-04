import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_SLOTS_CODE } from "../../protocol/constants";
// Buffer is a Node.js built-in, no import needed

export class SlotsCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    const message: SerialMessage = {
      boardAddress,
      command: CMD_SLOTS_CODE,
    };

    const response = await this.executeCommand(message);
    if (response.success && response.data.length >= 2) {
      const fillByte = response.data.readUInt8(0);
      const lockByte = response.data.readUInt8(1);

      const filledSlots = Array.from(Array(6).keys()).map(
        (slotIdx) => (fillByte >> slotIdx) & 1
      );
      const lockedSlots = Array.from(Array(6).keys()).map(
        (slotIdx) => (lockByte >> slotIdx) & 1
      );

      return {
        ...response,
        data: Buffer.from(JSON.stringify({ filledSlots, lockedSlots })),
      };
    }
    return response;
  }
}
