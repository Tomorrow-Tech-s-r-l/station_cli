import { Buffer } from "buffer";
import {
  CMD_STATUS_CODE,
  CMD_SET_CHARGE_CODE,
  CMD_RESET_CODE,
  CMD_SET_PDO_CODE,
  CMD_SLOTS_CODE,
  CMD_UNLOCK_CODE,
  CMD_SET_LED_CODE,
  CMD_SET_INFO,
  CMD_SET_INFO_POWERBANK,
  CMD_GET_FW_VER,
  MAXIMUM_SLOT_INDEX,
} from "./constants";
import { SerialMessage, CommandBuilder, CommandValidator } from "./types";

export type BoardCommand = {
  opCode: number;
  slotId?: number;
  param?: number;
  serialNumber?: string;
  timestamp?: number;
  cycles?: number;
  totalCharge?: number;
  currentCharge?: number;
  cutOffCharge?: number;
};

function buildCommand(command: BoardCommand): Buffer {
  let bytesWritten = 1;
  let payload: Buffer;

  if (command.opCode === CMD_SET_INFO) {
    payload = Buffer.alloc(18);
    payload.writeUInt8(command.opCode, 0);
    payload.writeUInt8(command.slotId!, 1);
    payload.write(command.serialNumber || "1234567", 2, 10, "utf8");
    payload.writeUInt32LE(
      command.timestamp || Math.floor(Date.now() / 1000),
      12
    );
    payload.writeUInt16LE(command.cycles || 0, 16);
    bytesWritten = 18;
  } else if (command.opCode === CMD_SET_INFO_POWERBANK) {
    payload = Buffer.alloc(8);
    payload.writeUInt8(command.opCode, 0);
    payload.writeUInt8(command.slotId!, 1);
    payload.writeUInt16LE(command.totalCharge || 13925, 2);
    payload.writeUInt16LE(command.currentCharge || 11625, 4);
    payload.writeUInt16LE(command.cutOffCharge || 10625, 6);
    bytesWritten = 8;
  } else {
    // Handle existing commands
    payload = Buffer.alloc(3);
    payload.writeUInt8(command.opCode, 0);
    if (command.slotId !== undefined) {
      payload.writeUInt8(command.slotId, 1);
      bytesWritten++;
    }
    if (command.param !== undefined) {
      payload.writeUInt8(command.param, 2);
      bytesWritten++;
    }
  }

  return payload.subarray(0, bytesWritten);
}

export function buildCommandForBoard(
  boardAddress: number,
  command: BoardCommand
): Buffer {
  const commandBin = buildCommand(command);
  const cmdWithAddr = Buffer.concat([Buffer.from([boardAddress]), commandBin]);
  return cmdWithAddr;
}

// Base command builder
export class BaseCommandBuilder implements CommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    const { command, data } = message;
    return data || Buffer.from([command]);
  }
}

// Status command builder
export class StatusCommandBuilder extends BaseCommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    if (!message.data || message.data.length !== 1) {
      throw new Error("Status command requires slot index");
    }
    return Buffer.from([CMD_STATUS_CODE, message.data[0]]);
  }
}

// Set charge command builder
export class SetChargeCommandBuilder extends BaseCommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    if (!message.data || message.data.length !== 2) {
      throw new Error("Set charge command requires slot index and power level");
    }
    return Buffer.from([CMD_SET_CHARGE_CODE, message.data[0], message.data[1]]);
  }
}

// Reset command builder
export class ResetCommandBuilder extends BaseCommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    if (!message.data || message.data.length !== 1) {
      throw new Error("Reset command requires slot index");
    }
    return Buffer.from([CMD_RESET_CODE, message.data[0]]);
  }
}

// Set PDO command builder
export class SetPdoCommandBuilder extends BaseCommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    if (!message.data || message.data.length !== 3) {
      throw new Error(
        "Set PDO command requires slot index, voltage, and current"
      );
    }
    return Buffer.from([
      CMD_SET_PDO_CODE,
      message.data[0],
      message.data[1],
      message.data[2],
    ]);
  }
}

// Slots command builder
export class SlotsCommandBuilder extends BaseCommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    return Buffer.from([CMD_SLOTS_CODE]);
  }
}

// Unlock command builder
export class UnlockCommandBuilder extends BaseCommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    if (!message.data || message.data.length !== 1) {
      throw new Error("Unlock command requires slot index");
    }
    return Buffer.from([CMD_UNLOCK_CODE, message.data[0]]);
  }
}

// Set LED command builder
export class SetLedCommandBuilder extends BaseCommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    if (!message.data || message.data.length !== 2) {
      throw new Error("Set LED command requires slot index and color");
    }
    return Buffer.from([CMD_SET_LED_CODE, message.data[0], message.data[1]]);
  }
}

// Set info command builder
export class SetInfoCommandBuilder extends BaseCommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    if (!message.data || message.data.length !== 18) {
      throw new Error(
        "Set info command requires slot index, serial, timestamp, and cycles"
      );
    }
    return Buffer.from([
      CMD_SET_INFO,
      message.data[0],
      ...message.data.slice(1, 18),
    ]);
  }
}

// Set battery info command builder
export class SetBatteryInfoCommandBuilder extends BaseCommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    if (!message.data || message.data.length !== 8) {
      throw new Error(
        "Set battery info command requires slot index, total charge, current charge, and cutoff charge"
      );
    }
    return Buffer.from([
      CMD_SET_INFO_POWERBANK,
      message.data[0],
      ...message.data.slice(1, 8),
    ]);
  }
}

// Firmware version command builder
export class FirmwareVersionCommandBuilder extends BaseCommandBuilder {
  buildCommand(message: SerialMessage): Buffer {
    return Buffer.from([CMD_GET_FW_VER]);
  }
}

// Command factory
export class CommandFactory {
  private static builders: Map<number, CommandBuilder> = new Map([
    [CMD_STATUS_CODE, new StatusCommandBuilder()],
    [CMD_SET_CHARGE_CODE, new SetChargeCommandBuilder()],
    [CMD_RESET_CODE, new ResetCommandBuilder()],
    [CMD_SET_PDO_CODE, new SetPdoCommandBuilder()],
    [CMD_SLOTS_CODE, new SlotsCommandBuilder()],
    [CMD_UNLOCK_CODE, new UnlockCommandBuilder()],
    [CMD_SET_LED_CODE, new SetLedCommandBuilder()],
    [CMD_SET_INFO, new SetInfoCommandBuilder()],
    [CMD_SET_INFO_POWERBANK, new SetBatteryInfoCommandBuilder()],
    [CMD_GET_FW_VER, new FirmwareVersionCommandBuilder()],
  ]);

  static getBuilder(command: number): CommandBuilder {
    const builder = this.builders.get(command);
    if (!builder) {
      throw new Error(`No builder found for command ${command}`);
    }
    return builder;
  }

  static buildCommand(message: SerialMessage): Buffer {
    // All commands except SLOTS and FW_VER require a slot index
    const command: BoardCommand = {
      opCode: message.command,
      slotId: message.data?.[0],
      param: message.data?.[1],
    };
    return buildCommandForBoard(message.boardAddress, command);
  }
}

// Base command validator
export class BaseCommandValidator implements CommandValidator {
  validate(message: SerialMessage): boolean {
    return true;
  }

  getErrorMessage(): string {
    return "Invalid command";
  }
}

// Slot command validator
export class SlotCommandValidator extends BaseCommandValidator {
  validate(message: SerialMessage): boolean {
    if (!message.data || message.data.length < 1) {
      return false;
    }
    const slotIndex = message.data[0];
    return slotIndex >= 0 && slotIndex <= MAXIMUM_SLOT_INDEX;
  }

  getErrorMessage(): string {
    return `Slot index must be between 0 and ${MAXIMUM_SLOT_INDEX}`;
  }
}

// Command validator factory
export class CommandValidatorFactory {
  private static validators: Map<number, CommandValidator> = new Map([
    [CMD_STATUS_CODE, new SlotCommandValidator()],
    [CMD_SET_CHARGE_CODE, new SlotCommandValidator()],
    [CMD_RESET_CODE, new SlotCommandValidator()],
    [CMD_SET_PDO_CODE, new SlotCommandValidator()],
    [CMD_UNLOCK_CODE, new SlotCommandValidator()],
    [CMD_SET_LED_CODE, new SlotCommandValidator()],
    [CMD_SET_INFO, new SlotCommandValidator()],
    [CMD_SET_INFO_POWERBANK, new SlotCommandValidator()],
  ]);

  static getValidator(command: number): CommandValidator {
    return this.validators.get(command) || new BaseCommandValidator();
  }

  static validate(message: SerialMessage): boolean {
    const validator = this.getValidator(message.command);
    return validator.validate(message);
  }

  static getErrorMessage(message: SerialMessage): string {
    const validator = this.getValidator(message.command);
    return validator.getErrorMessage();
  }
}
