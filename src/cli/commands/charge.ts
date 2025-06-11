import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_SET_CHARGE_CODE } from "../../protocol/constants";
import { mapSlotToBoard } from "../../utils/slot_mapping";
import { Buffer } from "buffer";

export class ChargeCommand extends BaseCommand {
  async execute(slotIndex: number, enable: boolean): Promise<CommandResponse> {
    const { boardAddress, slotInBoard } = mapSlotToBoard(slotIndex);

    const message: SerialMessage = {
      boardAddress,
      command: CMD_SET_CHARGE_CODE,
      data: Buffer.from([slotInBoard, enable ? 1 : 0]),
    };

    return await this.executeCommand(message);
  }
}
