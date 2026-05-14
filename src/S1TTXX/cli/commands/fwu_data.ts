import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_FWU_DATA_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";

/**
 * CMD_FWU_DATA (0x13): bootloader-side. Streams one chunk of the firmware
 * body into flash. The BL enforces strict sequential offset; on a mismatch
 * it returns RES_OFFSET_MISMATCH (0x10) along with the offset it expects
 * next, so the host can resync after a half-duplex glitch.
 *
 * Response payload (after the station strips [opcode][status]): a
 * 4-byte little-endian `nextExpectedOffset`.
 */
export interface FwuDataInfo {
  nextExpectedOffset: number;
}

export class FwuDataCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number,
    params: { offset: number; bytes: Buffer }
  ): Promise<CommandResponse & { info?: FwuDataInfo }> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new Error(
        `Slot index must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }
    if (params.bytes.length > 32) {
      throw new Error(
        `FWU_DATA chunk too large: ${params.bytes.length} > 32 (FWU_MAX_CHUNK)`
      );
    }

    const data = Buffer.alloc(6 + params.bytes.length);
    data.writeUInt8(slotAddress, 0);
    data.writeUInt32LE(params.offset >>> 0, 1);
    data.writeUInt8(params.bytes.length, 5);
    params.bytes.copy(data, 6);

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
