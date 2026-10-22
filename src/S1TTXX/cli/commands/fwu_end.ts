import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { stationTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

/**
 * CMD_FWU_END (0x64): bootloader-side. Verifies the rolling CRC32 of
 * the received body bytes against the value declared at FWU_BEGIN,
 * then writes the app header page magic-last so a power loss
 * mid-write leaves the slot invalid. On success the BL idles in BL
 * mode — call FWU_EXIT to reset back into the new app.
 */
export class FwuEndCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    return new FwuWire(this.serialService, stationTarget(boardAddress)).end();
  }
}
