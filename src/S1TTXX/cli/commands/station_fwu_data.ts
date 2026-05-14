import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_STATION_FWU_DATA_CODE } from "../../../utils/constants";

/**
 * CMD_STATION_FWU_DATA (0x63): bootloader-side. Streams one chunk of the
 * firmware body into flash. The BL enforces strict sequential offset; on
 * a mismatch it returns RES_OFFSET_MISMATCH (0x10) along with the offset
 * it expects next, so the host can resync after a wire glitch.
 *
 * Payload (5+len bytes, no slot index):
 *   [offset_u32_le][len_u8][bytes 0..len]
 *
 * Response payload after [opcode][status] is a 4-byte little-endian
 * nextExpectedOffset.
 */
export interface StationFwuDataInfo {
  nextExpectedOffset: number;
}

export const STATION_FWU_MAX_CHUNK = 32;

export class StationFwuDataCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    params: { offset: number; bytes: Buffer }
  ): Promise<CommandResponse & { info?: StationFwuDataInfo }> {
    if (params.bytes.length > STATION_FWU_MAX_CHUNK) {
      throw new Error(
        `STATION_FWU_DATA chunk too large: ${params.bytes.length} > ${STATION_FWU_MAX_CHUNK} (FWU_MAX_CHUNK)`
      );
    }

    const data = Buffer.alloc(5 + params.bytes.length);
    data.writeUInt32LE(params.offset >>> 0, 0);
    data.writeUInt8(params.bytes.length, 4);
    params.bytes.copy(data, 5);

    const message: SerialMessage = {
      boardAddress,
      command: CMD_STATION_FWU_DATA_CODE,
      data,
    };

    const response = await this.executeCommand(message);
    if (response.data.length >= 4) {
      const info: StationFwuDataInfo = {
        nextExpectedOffset: response.data.readUInt32LE(0),
      };
      return { ...response, info };
    }
    return response;
  }
}
