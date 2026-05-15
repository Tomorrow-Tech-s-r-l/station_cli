import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_FWU_HELLO_CODE } from "../../../utils/constants";

/**
 * CMD_FWU_HELLO (0x61): bootloader-side. Returns the BL version,
 * whether a valid application image is present, the app version, and
 * the slot-layout constants the host needs to drive an update.
 *
 * Wire layout after the station strips opcode + status:
 *
 *   bytes  0..0   bl_version_major   u8
 *   bytes  1..1   bl_version_minor   u8
 *   bytes  2..2   app_present        u8  (1 = valid app, 0 = none)
 *   bytes  3..6   app_version        u32 LE (zero if !app_present)
 *   bytes  7..8   max_chunk          u16 LE (recommended FWU_DATA bytes)
 *   bytes  9..10  page_size          u16 LE (flash page size, 1024)
 *   bytes 11..14  slot_size          u32 LE (app body bytes available)
 *
 * Mirrors bootloader/Src/fwu_protocol.c build_hello_response() byte-for-byte.
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

/**
 * V-40: the host's compile-time expectation of the BL FWU protocol
 * version. Must match `FWU_VERSION_MAJOR / FWU_VERSION_MINOR` in
 * `S1TTXX-firmware/bootloader/Inc/fwu_iface.h` and
 * `P1TT2C-firmware/App/Inc/fwu_iface.h`. When the BL is bumped, also
 * bump these constants and any wire-format / response-size changes
 * accordingly.
 */
export const FWU_HOST_EXPECTED_MAJOR = 0;
export const FWU_HOST_EXPECTED_MINOR = 1;

export class FwuHelloCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    const message: SerialMessage = {
      boardAddress,
      command: CMD_FWU_HELLO_CODE,
      data: Buffer.alloc(0),
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
      // V-40: warn (do not fail) on FWU protocol version skew so a
      // mismatched-BL situation is at least visible in the operator
      // log instead of "FWU just stops working in a weird way."
      if (
        info.blVersionMajor !== FWU_HOST_EXPECTED_MAJOR ||
        info.blVersionMinor !== FWU_HOST_EXPECTED_MINOR
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          `[FWU] bootloader version ${info.blVersionMajor}.${info.blVersionMinor} ` +
            `differs from host expectation ${FWU_HOST_EXPECTED_MAJOR}.${FWU_HOST_EXPECTED_MINOR} ` +
            `(V-40). Proceeding; update station_cli if FWU breaks.`
        );
      }
      return { ...response, data: Buffer.from(JSON.stringify(info)) };
    }
    return response;
  }
}
