import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_PB_FWU_END_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";

/**
 * CMD_PB_FWU_END (0x14): powerbank-bootloader-side. Verifies the rolling
 * CRC32 of the received body bytes matches the value declared at
 * PB_FWU_BEGIN, then writes the app header page magic-last so a power
 * loss mid-write leaves the slot invalid. On success the BL idles in
 * BL mode — call PB_FWU_EXIT to reset back into the new app.
 */
export class PbFwuEndCommand extends BaseCommand {
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
      command: CMD_PB_FWU_END_CODE,
      data: Buffer.from([slotAddress]),
    };
    return this.executeCommand(message);
  }
}
