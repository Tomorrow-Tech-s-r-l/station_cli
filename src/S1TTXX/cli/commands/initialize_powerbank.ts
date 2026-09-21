import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_SET_INFO_PWB,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";
import {
  DEFAULT_TOTAL_CHARGE_MAH,
  DEFAULT_CURRENT_CHARGE_MAH,
  DEFAULT_CUTOFF_CHARGE_MAH,
  checkInitialBatteryParams,
  describeBatteryFaults,
} from "../../utils/battery_info";
import { SetBatteryInfoCommand } from "./set_battery_info";
// Buffer is a Node.js built-in, no import needed

interface InitializePowerbankParams {
  serialNumber: string;
  timestamp?: number;
  cycles?: number;
  totalCharge?: number;
  currentCharge?: number;
  cutoffCharge?: number;
}

export class InitializePowerbankCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number,
    params: InitializePowerbankParams
  ): Promise<CommandResponse> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new Error(
        `Slot address must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }

    if (!params.serialNumber || params.serialNumber.length !== 10) {
      throw new Error("Serial number must be exactly 10 characters");
    }

    // Set default values. Nullish coalescing, not `||`: an explicit 0 must
    // reach the validation below rather than being silently replaced by the
    // default — writing a zeroed nameplate is exactly how a pack ends up
    // stuck at 0% and never charging again.
    const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000);
    const cycles = params.cycles ?? 0;
    const battery = {
      totalCharge: params.totalCharge ?? DEFAULT_TOTAL_CHARGE_MAH,
      currentCharge: params.currentCharge ?? DEFAULT_CURRENT_CHARGE_MAH,
      cutoffCharge: params.cutoffCharge ?? DEFAULT_CUTOFF_CHARGE_MAH,
    };

    const faults = checkInitialBatteryParams(battery);
    if (faults.length > 0) {
      throw new Error(
        `Refusing to write impossible battery parameters: ` +
          `${describeBatteryFaults(faults, battery)}. ` +
          `Required: cutoffCharge <= currentCharge <= totalCharge.`
      );
    }

    // Step 1: Send powerbank info (opcode 0x08)
    // Payload: [slotId, serial(10), timestamp(4), cycles(2)] = 17 bytes
    const infoPBData = Buffer.alloc(17);
    infoPBData.writeUInt8(slotAddress, 0);
    infoPBData.write(params.serialNumber, 1, 10, "utf8");
    infoPBData.writeUInt32LE(timestamp, 11);
    infoPBData.writeUInt16LE(cycles, 15);

    const infoPBMessage: SerialMessage = {
      boardAddress,
      command: CMD_SET_INFO_PWB,
      data: infoPBData,
    };

    const infoPBResponse = await this.executeCommand(infoPBMessage);

    if (!infoPBResponse.success) {
      throw new Error(
        `Failed to set powerbank info: status code ${infoPBResponse.status}`
      );
    }

    // Step 2: Send battery info (opcode 0x09)
    return await new SetBatteryInfoCommand(this.serialService).execute(
      boardAddress,
      slotAddress,
      battery
    );
  }
}
