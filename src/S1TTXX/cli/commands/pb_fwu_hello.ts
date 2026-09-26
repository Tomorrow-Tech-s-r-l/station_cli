import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { powerbankTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

export type { FwuHelloInfo as PbFwuHelloInfo } from "../../fwu/session/wire";

/**
 * CMD_PB_FWU_HELLO (0x11): powerbank-bootloader-side. Returns the
 * bootloader version, whether a valid application image is present,
 * the app version (if any), and the slot-layout constants needed by
 * the host to drive an update.
 *
 * Wire layout (after the station strips the opcode + status bytes):
 *
 *   bytes  0..0   bl_version_major   u8
 *   bytes  1..1   bl_version_minor   u8
 *   bytes  2..2   app_present        u8  (1 = valid app, 0 = none)
 *   bytes  3..6   app_version        u32 LE  (zero if !app_present)
 *   bytes  7..8   max_chunk          u16 LE  (recommended BL_DATA bytes)
 *   bytes  9..10  page_size          u16 LE  (flash page size, 1024)
 *   bytes 11..14  slot_size          u32 LE  (app body bytes available)
 */
export class PbFwuHelloCommand extends BaseCommand {
  async execute(boardAddress: number, slotAddress: number): Promise<CommandResponse> {
    return new FwuWire(this.serialService, powerbankTarget(boardAddress, slotAddress)).hello();
  }
}
