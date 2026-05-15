import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_PB_FWU_DATA_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";

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
export interface PbFwuDataInfo {
  nextExpectedOffset: number;
}

export class PbFwuDataCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number,
    params: { offset: number; bytes: Buffer; isFinal?: boolean }
  ): Promise<CommandResponse & { info?: PbFwuDataInfo }> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new Error(
        `Slot index must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }
    if (params.bytes.length > 32) {
      throw new Error(
        `PB_FWU_DATA chunk too large: ${params.bytes.length} > 32 (FWU_MAX_CHUNK)`
      );
    }
    // B-17 / V-29: only the final chunk may have an odd length. See
    // bootloader/Src/fwu_protocol.c (P1TT2C) for the mirror guard.
    if (
      (params.bytes.length & 1) === 1 &&
      params.isFinal !== true
    ) {
      throw new Error(
        `PB_FWU_DATA non-final chunk must be even-length (got ${params.bytes.length}); ` +
          `set isFinal=true on the last chunk only`
      );
    }

    const data = Buffer.alloc(6 + params.bytes.length);
    data.writeUInt8(slotAddress, 0);
    data.writeUInt32LE(params.offset >>> 0, 1);
    data.writeUInt8(params.bytes.length, 5);
    params.bytes.copy(data, 6);

    const message: SerialMessage = {
      boardAddress,
      command: CMD_PB_FWU_DATA_CODE,
      data,
    };

    const response = await this.executeCommand(message);
    if (response.data.length >= 4) {
      const info: PbFwuDataInfo = {
        nextExpectedOffset: response.data.readUInt32LE(0),
      };
      return { ...response, info };
    }
    return response;
  }
}
