import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_UNLOCK_CODE } from "../../../utils/constants";
import { mapSlotToBoard } from "../../utils/slot_mapping";
// Buffer is a Node.js built-in, no import needed

export class UnlockCommand extends BaseCommand {
  /**
   * @param slotIndex 1-based slot index.
   * @param verify    Ask the station to confirm, via the slot's powerbank
   *                  presence sensor, that the pack actually left the slot.
   *                  Sends the optional third request byte; the station then
   *                  answers ERR_UNLOCK_FAILED (0x20) if the pack is still
   *                  there. Off by default, which emits the same two-byte
   *                  frame as before — firmware predating the verify byte
   *                  rejects a three-byte one with ERR_INVALID_ARGS.
   */
  async execute(
    slotIndex: number,
    verify: boolean = false
  ): Promise<CommandResponse> {
    const { boardAddress, slotInBoard } = mapSlotToBoard(slotIndex);

    const message: SerialMessage = {
      boardAddress,
      command: CMD_UNLOCK_CODE,
      data: Buffer.from(verify ? [slotInBoard, 1] : [slotInBoard]),
    };

    return await this.executeCommand(message);
  }
}
