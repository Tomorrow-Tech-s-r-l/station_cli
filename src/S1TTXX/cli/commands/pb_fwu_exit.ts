import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { powerbankTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

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
  async execute(boardAddress: number, slotAddress: number): Promise<CommandResponse> {
    return new FwuWire(this.serialService, powerbankTarget(boardAddress, slotAddress)).exit();
  }
}
