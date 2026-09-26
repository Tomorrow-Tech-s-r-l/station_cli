import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { powerbankTarget } from "../../fwu/session/target";
import { FwuDataInfo } from "../../fwu/session/wire";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

export type { FwuDataInfo as PbFwuDataInfo } from "../../fwu/session/wire";

/**
 * CMD_PB_FWU_DATA (0x13): powerbank-bootloader-side. Streams one chunk
 * of the firmware body into flash. The BL enforces strict sequential
 * offset; on a mismatch it returns RES_OFFSET_MISMATCH (0x10) along
 * with the offset it expects next, so the host can resync after a
 * half-duplex glitch.
 *
 * Response payload (after the station strips [opcode][status]): a
 * 4-byte little-endian `nextExpectedOffset`.
 */
export class PbFwuDataCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number,
    params: { offset: number; bytes: Buffer; isFinal?: boolean }
  ): Promise<CommandResponse & { info?: FwuDataInfo }> {
    return new FwuWire(this.serialService, powerbankTarget(boardAddress, slotAddress)).data(params);
  }
}
