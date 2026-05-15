import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_FWU_EXIT_CODE } from "../../../utils/constants";

/**
 * CMD_FWU_EXIT (0x66): bootloader-side. The BL acks with
 * [opcode][SUCCESS] and then calls NVIC_SystemReset(). Because the BL
 * clears the rendezvous magic at the start of every cold entry, the
 * reset boots straight back into the application — no second ENTER
 * round-trip needed.
 *
 * After the ack the device is unresponsive for ~30 ms while it resets.
 */
export class FwuExitCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    const message: SerialMessage = {
      boardAddress,
      command: CMD_FWU_EXIT_CODE,
      data: Buffer.alloc(0),
    };
    return this.executeCommand(message);
  }
}
