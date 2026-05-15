import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_FWU_DATA_CODE } from "../../../utils/constants";

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
export interface FwuDataInfo {
  nextExpectedOffset: number;
}

export const FWU_MAX_CHUNK = 32;

export class FwuDataCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    params: { offset: number; bytes: Buffer; isFinal?: boolean }
  ): Promise<CommandResponse & { info?: FwuDataInfo }> {
    if (params.bytes.length > FWU_MAX_CHUNK) {
      throw new Error(
        `FWU_DATA chunk too large: ${params.bytes.length} > ${FWU_MAX_CHUNK} (FWU_MAX_CHUNK)`
      );
    }
    // B-17 / V-29: only the final chunk may carry an odd-length payload.
    // The bootloader's program_chunk would otherwise pad the trailing
    // half-word with 0xFF, and the next contiguous DATA would conflict on
    // that already-programmed cell -> FLASH_SR_PGERR, FWU session soft-bricks.
    if (
      (params.bytes.length & 1) === 1 &&
      params.isFinal !== true
    ) {
      throw new Error(
        `FWU_DATA non-final chunk must be even-length (got ${params.bytes.length}); ` +
          `set isFinal=true on the last chunk only`
      );
    }

    const data = Buffer.alloc(5 + params.bytes.length);
    data.writeUInt32LE(params.offset >>> 0, 0);
    data.writeUInt8(params.bytes.length, 4);
    params.bytes.copy(data, 5);

    const message: SerialMessage = {
      boardAddress,
      command: CMD_FWU_DATA_CODE,
      data,
    };

    const response = await this.executeCommand(message);
    if (response.data.length >= 4) {
      const info: FwuDataInfo = {
        nextExpectedOffset: response.data.readUInt32LE(0),
      };
      return { ...response, info };
    }
    return response;
  }
}
