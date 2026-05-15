import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_PB_FWU_ABORT_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";

/**
 * CMD_PB_FWU_ABORT (0x15): powerbank-bootloader-side. Tears down the
 * active session. The header page is already erased (PB_FWU_BEGIN did
 * it on the way in), so the slot stays invalid until the next
 * successful update. Use this to cleanly back out of a partial update
 * before retrying.
 */
export class PbFwuAbortCommand extends BaseCommand {
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
      command: CMD_PB_FWU_ABORT_CODE,
      data: Buffer.from([slotAddress]),
    };
    return this.executeCommand(message);
  }
}
