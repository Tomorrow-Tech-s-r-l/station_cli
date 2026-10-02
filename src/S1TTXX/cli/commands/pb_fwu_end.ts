import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { powerbankTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

/**
 * CMD_PB_FWU_END (0x14): powerbank-bootloader-side. Verifies the rolling
 * CRC32 of the received body bytes matches the value declared at
 * PB_FWU_BEGIN, then writes the app header page magic-last so a power
 * loss mid-write leaves the slot invalid. On success the BL idles in
 * BL mode — call PB_FWU_EXIT to reset back into the new app.
 */
export class PbFwuEndCommand extends BaseCommand {
  async execute(boardAddress: number, slotAddress: number): Promise<CommandResponse> {
    return new FwuWire(this.serialService, powerbankTarget(boardAddress, slotAddress)).end();
  }
}
