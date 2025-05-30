import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_SET_LED_CODE } from "../../protocol/constants";
import { mapSlotToBoard } from "../../utils/slot_mapping";
import { Buffer } from "buffer";

export class LedCommand extends BaseCommand {
  async execute(slotIndex: number, state: boolean): Promise<CommandResponse> {
    const { boardAddress, slotInBoard } = mapSlotToBoard(slotIndex);

    // Invert the slot number within the board (0->5, 1->4, 2->3, etc.)
    const invertedSlotInBoard = 5 - slotInBoard;

    const message: SerialMessage = {
      boardAddress,
      command: CMD_SET_LED_CODE,
      data: Buffer.from([invertedSlotInBoard, state ? 1 : 0]),
    };

    return await this.executeCommand(message);
  }
}
