import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { stationTarget } from "../../fwu/session/target";
import { FwuDataInfo } from "../../fwu/session/wire";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

export type { FwuDataInfo } from "../../fwu/session/wire";
export { FWU_MAX_CHUNK } from "../../fwu/session/wire";

/**
 * CMD_FWU_DATA (0x63): bootloader-side. Streams one chunk of the
 * firmware body into flash. The BL enforces strict sequential offset;
 * on a mismatch it returns RES_OFFSET_MISMATCH (0x10) along with the
 * offset it expects next, so the host can resync after a wire glitch.
 *
 * Payload (5+len bytes, no slot index):
 *   [offset_u32_le][len_u8][bytes 0..len]
 *
 * Response payload after [opcode][status] is a 4-byte little-endian
 * nextExpectedOffset.
 */
export class FwuDataCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    params: { offset: number; bytes: Buffer; isFinal?: boolean }
  ): Promise<CommandResponse & { info?: FwuDataInfo }> {
    return new FwuWire(this.serialService, stationTarget(boardAddress)).data(params);
  }
}
