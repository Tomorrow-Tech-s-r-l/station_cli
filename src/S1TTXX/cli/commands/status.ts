import { BaseCommand } from "./base";
import {
  SerialMessage,
  CommandResponse,
  PowerbankInfo,
} from "../../protocol/types";
import {
  CMD_STATUS_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";
// Buffer is a Node.js built-in, no import needed

export class StatusCommand extends BaseCommand {
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
      command: CMD_STATUS_CODE,
      data: Buffer.from([slotAddress]),
    };

    const response = await this.executeCommand(message);
    if (response.success && response.data.length >= 19) {
      // Parse powerbank info from response data.
      // Layout (offsets in bytes):
      //   0..9   serial
      //   10..13 timestamp
      //   14..15 totalCharge
      //   16..17 currentCharge
      //   18..19 cutoffCharge
      //   20..21 cycles
      //   22     status
      //   23..24 avgCapacity (added with BF-260512 adaptive-capacity fix; 0 on old fw)
      //
      // packVoltageMv is NOT implemented by this S1TTXX-firmware checkout:
      // that feature exists upstream (commit ceae8b3) behind a dedicated
      // PB_CMD_INFO_EXT opcode, but this checkout was deliberately left
      // un-synced (BF-260512 follow-up) and P1TT2C doesn't implement that
      // opcode either. It's hardcoded to 0 rather than derived from length
      // so it can't be mistaken for avgCapacity, which also lands at
      // offset 23..24 and is what actually makes response.data.length hit
      // 25 on current firmware.
      const hasAvgCapacity = response.data.length >= 25;
      const info: PowerbankInfo = {
        serial: response.data
          .subarray(0, 10)
          .toString("utf8")
          .trim()
          .replace(/\0/g, ""),
        timestamp: response.data.readUInt32LE(10),
        totalCharge: response.data.readUInt16LE(14),
        currentCharge: response.data.readUInt16LE(16),
        cutoffCharge: response.data.readUInt16LE(18),
        cycles: response.data.readUInt16LE(20),
        status: response.data.readUInt8(22),
        packVoltageMv: 0,
        avgCapacity: hasAvgCapacity ? response.data.readUInt16LE(23) : 0,
      };
      return { ...response, data: Buffer.from(JSON.stringify(info)) };
    }
    return response;
  }
}
