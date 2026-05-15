import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_PB_FWU_EXIT_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";

/**
 * CMD_PB_FWU_EXIT (0x16): powerbank-bootloader-side. The BL acks with
 * [opcode][FWU_RES_SUCCESS] and then calls NVIC_SystemReset(). Because
 * the BL clears the rendezvous magic at the start of every cold entry,
 * the reset boots straight back into the application — no second
 * PB_ENTER_BOOT round-trip needed.
 *
 * After the ack the device is unresponsive for ~30 ms while it resets.
 */
export class PbFwuExitCommand extends BaseCommand {
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
      command: CMD_PB_FWU_EXIT_CODE,
      data: Buffer.from([slotAddress]),
    };

    return this.executeCommand(message);
  }
}
