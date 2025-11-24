import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_SET_INFO_PWB,
  CMD_SET_INFO_BATTERY,
  MAXIMUM_SLOT_ADDRESS,
} from "../../protocol/constants";
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

    // Set default values
    const timestamp = params.timestamp || Math.floor(Date.now() / 1000);
    const cycles = params.cycles || 0;
    const totalCharge = params.totalCharge || 13925; // Default: 13925 mAh
    const currentCharge = params.currentCharge || 11625; // Default: 11625 mAh
    const cutoffCharge = params.cutoffCharge || 10625; // Default: 10625 mAh

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
    // Payload: [slotId, totalCharge(2), currentCharge(2), cutoffCharge(2)] = 7 bytes
    const batteryData = Buffer.alloc(7);
    batteryData.writeUInt8(slotAddress, 0);
    batteryData.writeUInt16LE(totalCharge, 1);
    batteryData.writeUInt16LE(currentCharge, 3);
    batteryData.writeUInt16LE(cutoffCharge, 5);

    const batteryMessage: SerialMessage = {
      boardAddress,
      command: CMD_SET_INFO_BATTERY,
      data: batteryData,
    };

    return await this.executeCommand(batteryMessage);
  }
}
