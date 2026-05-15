import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_PB_FWU_BEGIN_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";

/**
 * CMD_PB_FWU_BEGIN (0x12): powerbank-bootloader-side. Tears down any
 * previous session, erases the app header page (so the slot is marked
 * invalid for the duration of the update), and arms a new session. The
 * image size, CRC32, and version travel in the request body; nothing
 * else flows over the pogo wire — the body bytes themselves come in
 * via CMD_PB_FWU_DATA.
 */
export class PbFwuBeginCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number,
    params: { imgSize: number; imgCrc32: number; version: number }
  ): Promise<CommandResponse> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new Error(
        `Slot index must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }

    const data = Buffer.alloc(13);
    data.writeUInt8(slotAddress, 0);
    data.writeUInt32LE(params.imgSize, 1);
    data.writeUInt32LE(params.imgCrc32 >>> 0, 5);
    data.writeUInt32LE(params.version >>> 0, 9);

    const message: SerialMessage = {
      boardAddress,
      command: CMD_PB_FWU_BEGIN_CODE,
      data,
    };
    return this.executeCommand(message);
  }
}
