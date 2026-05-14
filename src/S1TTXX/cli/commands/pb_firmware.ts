import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_PB_FW_VER_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";

/**
 * CMD_PB_FW_VER (0x0a, host wire): read the application-firmware name and
 * version strings the powerbank was built with. Both fields are sourced
 * from the powerbank's `package.json` at build time (see CMakeLists.txt's
 * "Build version + name" block) and baked into the binary as `FW_NAME` and
 * `FW_VERSION`. This command returns them verbatim.
 *
 * Use this to confirm what's actually running on a slot before / after an
 * OTA update via `firmware-update`. It is non-disruptive — answered by the
 * running app over the half-duplex pogo link without resetting into the
 * bootloader.
 *
 * Wire payload after the station strips `[opcode][status]`:
 *   - bytes 0..15  : name field    (16 B, NUL-padded)
 *   - bytes 16..28 : version field (13 B, NUL-padded)
 * The station guarantees NUL termination on both fields in
 * pb_protocol_decode_response so we can safely treat them as C strings.
 */
const PB_FW_NAME_FIELD_LEN = 16;
const PB_FW_VERSION_FIELD_LEN = 13;

function readNulTerminated(buf: Buffer, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) {
    end++;
  }
  return buf.subarray(offset, end).toString("utf8");
}

export interface PbFirmwareInfo {
  name: string;
  version: string;
}

export class PbFirmwareCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number
  ): Promise<CommandResponse & { info?: PbFirmwareInfo }> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new Error(
        `Slot index must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }

    const message: SerialMessage = {
      boardAddress,
      command: CMD_PB_FW_VER_CODE,
      data: Buffer.from([slotAddress]),
    };

    const response = await this.executeCommand(message);
    if (
      response.success &&
      response.data.length >= PB_FW_NAME_FIELD_LEN + PB_FW_VERSION_FIELD_LEN
    ) {
      const name = readNulTerminated(response.data, 0, PB_FW_NAME_FIELD_LEN);
      const version = readNulTerminated(
        response.data,
        PB_FW_NAME_FIELD_LEN,
        PB_FW_VERSION_FIELD_LEN
      );
      return { ...response, info: { name, version } };
    }
    return response;
  }
}
