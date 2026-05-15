import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_PB_FWU_HELLO_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";
import {
  FWU_HOST_EXPECTED_MAJOR,
  FWU_HOST_EXPECTED_MINOR,
} from "./fwu_hello";

/**
 * CMD_PB_FWU_HELLO (0x11): powerbank-bootloader-side. Returns the
 * bootloader version, whether a valid application image is present,
 * the app version (if any), and the slot-layout constants needed by
 * the host to drive an update.
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
export interface PbFwuHelloInfo {
  blVersionMajor: number;
  blVersionMinor: number;
  appPresent: boolean;
  appVersion: number;
  maxChunk: number;
  pageSize: number;
  slotSize: number;
}

const PB_FWU_HELLO_PAYLOAD_BYTES = 15;

export class PbFwuHelloCommand extends BaseCommand {
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
      command: CMD_PB_FWU_HELLO_CODE,
      data: Buffer.from([slotAddress]),
    };

    const response = await this.executeCommand(message);
    if (response.success && response.data.length >= PB_FWU_HELLO_PAYLOAD_BYTES) {
      const info: PbFwuHelloInfo = {
        blVersionMajor: response.data.readUInt8(0),
        blVersionMinor: response.data.readUInt8(1),
        appPresent: response.data.readUInt8(2) === 1,
        appVersion: response.data.readUInt32LE(3),
        maxChunk: response.data.readUInt16LE(7),
        pageSize: response.data.readUInt16LE(9),
        slotSize: response.data.readUInt32LE(11),
      };
      // V-40: warn (do not fail) on FWU protocol version skew. Same
      // policy as fwu_hello.ts; powerbank- and station-side BLs share
      // the major/minor constants today (both at 0.1).
      if (
        info.blVersionMajor !== FWU_HOST_EXPECTED_MAJOR ||
        info.blVersionMinor !== FWU_HOST_EXPECTED_MINOR
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          `[PB-FWU] powerbank BL version ${info.blVersionMajor}.${info.blVersionMinor} ` +
            `differs from host expectation ${FWU_HOST_EXPECTED_MAJOR}.${FWU_HOST_EXPECTED_MINOR} ` +
            `(V-40, slot ${slotAddress}). Proceeding; update station_cli if PB FWU breaks.`
        );
      }
      return { ...response, data: Buffer.from(JSON.stringify(info)) };
    }
    return response;
  }
}
