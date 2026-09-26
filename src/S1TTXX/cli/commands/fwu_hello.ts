import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { stationTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

export type { FwuHelloInfo } from "../../fwu/session/wire";
export { FWU_HOST_EXPECTED_MAJOR, FWU_HOST_EXPECTED_MINOR } from "../../fwu/session/wire";

/**
 * CMD_FWU_HELLO (0x61): bootloader-side. Returns the BL version,
 * whether a valid application image is present, the app version, and
 * the slot-layout constants the host needs to drive an update.
 *
 * Wire layout after the station strips opcode + status:
 *
 *   bytes  0..0   bl_version_major   u8
 *   bytes  1..1   bl_version_minor   u8
 *   bytes  2..2   app_present        u8  (1 = valid app, 0 = none)
 *   bytes  3..6   app_version        u32 LE (zero if !app_present)
 *   bytes  7..8   max_chunk          u16 LE (recommended FWU_DATA bytes)
 *   bytes  9..10  page_size          u16 LE (flash page size, 1024)
 *   bytes 11..14  slot_size          u32 LE (app body bytes available)
 *
 * Mirrors bootloader/Src/fwu_protocol.c build_hello_response() byte-for-byte.
 */

/**
 * V-40: the host's compile-time expectation of the BL FWU protocol
 * version. Must match `FWU_VERSION_MAJOR / FWU_VERSION_MINOR` in
 * `S1TTXX-firmware/bootloader/Inc/fwu_iface.h` and
 * `P1TT2C-firmware/App/Inc/fwu_iface.h`. When the BL is bumped, also
 * bump these constants and any wire-format / response-size changes
 * accordingly.
 */
export class FwuHelloCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    return new FwuWire(this.serialService, stationTarget(boardAddress)).hello();
  }
}
