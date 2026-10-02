import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { stationTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

/**
 * CMD_FWU_ABORT (0x65): bootloader-side. Tears down the active
 * session. The header page is already erased (FWU_BEGIN did it on the
 * way in), so the slot stays invalid until the next successful
 * update. Use this to cleanly back out of a partial update before
 * retrying.
 */
export class FwuAbortCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    return new FwuWire(this.serialService, stationTarget(boardAddress)).abort();
  }
}
