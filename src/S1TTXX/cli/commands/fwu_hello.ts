import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_FWU_HELLO_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";

/**
 * CMD_FWU_HELLO (0x11): bootloader-side. Returns the bootloader version,
 * whether a valid application image is present, the app version (if any),
 * and the slot-layout constants needed by the host to drive an update.
 *
 * Wire layout (after the station strips the opcode + status bytes):
 *
 *   bytes  0..0   bl_version_major   u8
 *   bytes  1..1   bl_version_minor   u8
 *   bytes  2..2   app_present        u8  (1 = valid app, 0 = none)
 *   bytes  3..6   app_version        u32 LE  (zero if !app_present)
 *   bytes  7..8   max_chunk          u16 LE  (recommended BL_DATA bytes)
 *   bytes  9..10  page_size          u16 LE  (flash page size, 1024)
 *   bytes 11..14  slot_size          u32 LE  (app body bytes available)
 */
export interface FwuHelloInfo {
  blVersionMajor: number;
  blVersionMinor: number;
  appPresent: boolean;
  appVersion: number;
  maxChunk: number;
  pageSize: number;
  slotSize: number;
}

const FWU_HELLO_PAYLOAD_BYTES = 15;

export class FwuHelloCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number
  ): Promise<CommandResponse> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new Error(
        `Slot index must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }

    const message: SerialMessage = {
      boardAddress,
      command: CMD_FWU_HELLO_CODE,
      data: Buffer.from([slotAddress]),
    };

    const response = await this.executeCommand(message);
    if (response.success && response.data.length >= FWU_HELLO_PAYLOAD_BYTES) {
      const info: FwuHelloInfo = {
        blVersionMajor: response.data.readUInt8(0),
        blVersionMinor: response.data.readUInt8(1),
        appPresent: response.data.readUInt8(2) === 1,
        appVersion: response.data.readUInt32LE(3),
        maxChunk: response.data.readUInt16LE(7),
        pageSize: response.data.readUInt16LE(9),
        slotSize: response.data.readUInt32LE(11),
      };
      return { ...response, data: Buffer.from(JSON.stringify(info)) };
    }
    return response;
  }
}
