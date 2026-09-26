import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { stationTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

/**
 * CMD_FWU_BEGIN (0x62): bootloader-side. Tears down any previous
 * session, erases the app header page (so the slot is marked invalid
 * for the duration of the update), and arms a new session. The image
 * size, CRC32, and version travel in the request body; nothing else
 * flows over USART1 — the body bytes themselves come in via FWU_DATA.
 *
 * Payload (12 bytes, no slot index — this targets the station itself):
 *   [img_size_u32_le][img_crc32_u32_le][version_u32_le]
 */
export class FwuBeginCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    params: { imgSize: number; imgCrc32: number; version: number }
  ): Promise<CommandResponse> {
    return new FwuWire(this.serialService, stationTarget(boardAddress)).begin(params);
  }
}
