import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { powerbankTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

/**
 * CMD_PB_FWU_BEGIN (0x12): powerbank-bootloader-side. Tears down any
 * previous session, erases the app header page (so the slot is marked
 * invalid for the duration of the update), and arms a new session. The
 * image size, CRC32, and version travel in the request body; nothing
 * else flows over the pogo wire — the body bytes themselves come in
 * via CMD_PB_FWU_DATA.
 */
export class PbFwuBeginCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number,
    params: { imgSize: number; imgCrc32: number; version: number }
  ): Promise<CommandResponse> {
    return new FwuWire(this.serialService, powerbankTarget(boardAddress, slotAddress)).begin(params);
  }
}
