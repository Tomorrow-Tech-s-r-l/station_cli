import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { powerbankTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

/**
 * CMD_PB_FWU_ABORT (0x15): powerbank-bootloader-side. Tears down the
 * active session. The header page is already erased (PB_FWU_BEGIN did
 * it on the way in), so the slot stays invalid until the next
 * successful update. Use this to cleanly back out of a partial update
 * before retrying.
 */
export class PbFwuAbortCommand extends BaseCommand {
  async execute(boardAddress: number, slotAddress: number): Promise<CommandResponse> {
    return new FwuWire(this.serialService, powerbankTarget(boardAddress, slotAddress)).abort();
  }
}
