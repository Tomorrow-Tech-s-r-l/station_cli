import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_SET_INFO_BATTERY,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";
import { BatteryChargeParams } from "../../utils/battery_info";
// Buffer is a Node.js built-in, no import needed

/**
 * Writes the battery nameplate of a docked powerbank (CMD_SET_INFO_BATTERY,
 * 0x09). Split out of InitializePowerbankCommand so `slots` can repair a
 * pack's impossible charge parameters without also rewriting its serial
 * number, manufacturing timestamp and cycle count (CMD_SET_INFO_PWB).
 */
export class SetBatteryInfoCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number,
    params: BatteryChargeParams
  ): Promise<CommandResponse> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new Error(
        `Slot address must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }

    // Payload: [slotId, totalCharge(2), currentCharge(2), cutoffCharge(2)]
    const data = Buffer.alloc(7);
    data.writeUInt8(slotAddress, 0);
    data.writeUInt16LE(params.totalCharge, 1);
    data.writeUInt16LE(params.currentCharge, 3);
    data.writeUInt16LE(params.cutoffCharge, 5);

    const message: SerialMessage = {
      boardAddress,
      command: CMD_SET_INFO_BATTERY,
      data,
    };

    return await this.executeCommand(message);
  }
}
