import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_FWU_ABORT_CODE } from "../../../utils/constants";

/**
 * CMD_FWU_ABORT (0x65): bootloader-side. Tears down the active
 * session. The header page is already erased (FWU_BEGIN did it on the
 * way in), so the slot stays invalid until the next successful
 * update. Use this to cleanly back out of a partial update before
 * retrying.
 */
export class FwuAbortCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    const message: SerialMessage = {
      boardAddress,
      command: CMD_FWU_ABORT_CODE,
      data: Buffer.alloc(0),
    };
    return this.executeCommand(message);
  }
}
