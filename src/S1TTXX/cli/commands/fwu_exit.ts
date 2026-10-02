import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { stationTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

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
    return new FwuWire(this.serialService, stationTarget(boardAddress)).exit();
  }
}
