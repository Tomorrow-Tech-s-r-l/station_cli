import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_UNLOCK_CODE,
  MAXIMUM_SLOT_INDEX,
  MAXIMUM_BOARD_ADDRESS,
} from "../../protocol/constants";
import { Buffer } from "buffer";

export class UnlockCommand extends BaseCommand {
  async execute(slotIndex: number): Promise<CommandResponse> {
    if (slotIndex < 1 || slotIndex > 30) {
      throw new Error("Slot index must be between 1 and 30");
    }

    // Slot to board mapping:
    // Slot 1-6   → Board 0, Slots 0-5
    // Slot 7-12  → Board 1, Slots 0-5
    // Slot 13-18 → Board 2, Slots 0-5
    // Slot 19-24 → Board 3, Slots 0-5
    // Slot 25-30 → Board 4, Slots 0-5
    //
    // Examples:
    // - Slot 30 → Board 4 (zeroBasedIndex 29 / 6 = 4), Slot 5 (29 % 6 = 5)
    // - Slot 1  → Board 0 (zeroBasedIndex 0 / 6 = 0),  Slot 0 (0 % 6 = 0)
    // - Slot 7  → Board 1 (zeroBasedIndex 6 / 6 = 1),  Slot 0 (6 % 6 = 0)

    // Convert 1-based index to 0-based and calculate board address
    const zeroBasedIndex = slotIndex - 1;
    const boardAddress = Math.floor(zeroBasedIndex / 6); // 6 slots per board
    const slotInBoard = zeroBasedIndex % 6; // 0-5 for slots within board

    if (boardAddress > MAXIMUM_BOARD_ADDRESS) {
      throw new Error(
        `Invalid slot index: ${slotIndex} (board ${boardAddress} exceeds maximum ${MAXIMUM_BOARD_ADDRESS})`
      );
    }

    const message: SerialMessage = {
      boardAddress,
      command: CMD_UNLOCK_CODE,
      data: Buffer.from([slotInBoard]),
    };

    return await this.executeCommand(message);
  }
}
