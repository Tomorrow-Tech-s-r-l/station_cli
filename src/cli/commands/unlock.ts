import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_UNLOCK_CODE } from "../../protocol/constants";
import { mapSlotToBoard } from "../../utils/slot_mapping";
import { Buffer } from "buffer";

export class UnlockCommand extends BaseCommand {
  async execute(slotIndex: number): Promise<CommandResponse> {
    const { boardAddress, slotInBoard } = mapSlotToBoard(slotIndex);

    const message: SerialMessage = {
      boardAddress,
      command: CMD_UNLOCK_CODE,
      data: Buffer.from([slotInBoard]),
    };

    return await this.executeCommand(message);
  }
}
