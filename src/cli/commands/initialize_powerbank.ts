import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_SET_INFO_PWB,
  MAXIMUM_SLOT_ADDRESS,
} from "../../protocol/constants";
import { Buffer } from "buffer";

interface InitializePowerbankParams {
  serialNumber?: string;
  timestamp?: number;
  cycles?: number;
}

export class InitializePowerbankCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number,
    params: InitializePowerbankParams = {}
  ): Promise<CommandResponse> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new Error(
        `Slot address must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }

    if (!params.serialNumber || params.serialNumber.length !== 10) {
      throw new Error("Serial number must be exactly 10 characters");
    }

    if (!params.timestamp || params.timestamp < 0) {
      throw new Error("Timestamp must be a positive number");
    }

    if (!params.cycles || params.cycles < 0) {
      throw new Error("Cycles must be a positive number");
    }

    const data = Buffer.concat([
      Buffer.from([slotAddress]),
      Buffer.from(params.serialNumber.padEnd(10, "\0"), "utf8"),
      Buffer.alloc(4), // Reserve space for timestamp
      Buffer.alloc(2), // Reserve space for cycles
    ]);

    // Write timestamp and cycles in little-endian format
    data.writeUInt32LE(params.timestamp, 11);
    data.writeUInt16LE(params.cycles, 15);

    const message: SerialMessage = {
      boardAddress,
      command: CMD_SET_INFO_PWB,
      data,
    };

    return await this.executeCommand(message);
  }
}
