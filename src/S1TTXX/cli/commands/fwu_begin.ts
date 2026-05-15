import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_FWU_BEGIN_CODE } from "../../../utils/constants";

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
    const data = Buffer.alloc(12);
    data.writeUInt32LE(params.imgSize, 0);
    data.writeUInt32LE(params.imgCrc32 >>> 0, 4);
    data.writeUInt32LE(params.version >>> 0, 8);

    const message: SerialMessage = {
      boardAddress,
      command: CMD_FWU_BEGIN_CODE,
      data,
    };
    return this.executeCommand(message);
  }
}
