import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_STATION_FWU_HELLO_CODE } from "../../../utils/constants";

/**
 * CMD_STATION_FWU_HELLO (0x61): bootloader-side. Returns the BL version,
 * whether a valid application image is present, the app version, and the
 * slot-layout constants the host needs to drive an update.
 *
 * Wire layout after the station strips opcode + status:
 *
 *   bytes  0..0   bl_version_major   u8
 *   bytes  1..1   bl_version_minor   u8
 *   bytes  2..2   app_present        u8  (1 = valid app, 0 = none)
 *   bytes  3..6   app_version        u32 LE (zero if !app_present)
 *   bytes  7..8   max_chunk          u16 LE (recommended STATION_FWU_DATA bytes)
 *   bytes  9..10  page_size          u16 LE (flash page size, 1024)
 *   bytes 11..14  slot_size          u32 LE (app body bytes available)
 *
 * Mirrors bootloader/Src/fwu_protocol.c build_hello_response() byte-for-byte.
 */
export interface StationFwuHelloInfo {
  blVersionMajor: number;
  blVersionMinor: number;
  appPresent: boolean;
  appVersion: number;
  maxChunk: number;
  pageSize: number;
  slotSize: number;
}

const STATION_FWU_HELLO_PAYLOAD_BYTES = 15;

export class StationFwuHelloCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    const message: SerialMessage = {
      boardAddress,
      command: CMD_STATION_FWU_HELLO_CODE,
      data: Buffer.alloc(0),
    };

    const response = await this.executeCommand(message);
    if (response.success && response.data.length >= STATION_FWU_HELLO_PAYLOAD_BYTES) {
      const info: StationFwuHelloInfo = {
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
