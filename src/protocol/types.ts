import { Buffer } from "buffer";

// Basic message structure
export interface SerialMessage {
  boardAddress: number;
  command: number;
  data?: Buffer;
}

// Command response structure
export interface CommandResponse {
  success: boolean;
  status: number;
  data: Buffer;
}

// Status command response payload
export interface StatusResponsePayload {
  serial: string;
  manufTs: string;
  totalCharge: string;
  currentCharge: string;
  cutoffCharge: string;
  cycles: number;
  pbStatus: number;
}

// Slots command response payload
export interface SlotsResponsePayload {
  slots: Array<{
    slot: number;
    status: "Empty" | "Filled" | "Locked";
  }>;
}

// Firmware version response payload
export interface FirmwareResponsePayload {
  version: string;
}

// Command builders
export interface CommandBuilder {
  buildCommand(message: SerialMessage): Buffer;
}

// Command validators
export interface CommandValidator {
  validate(message: SerialMessage): boolean;
  getErrorMessage(): string;
}

// Command handlers
export interface CommandHandler {
  execute(message: SerialMessage): Promise<CommandResponse>;
  validate(message: SerialMessage): boolean;
  getErrorMessage(): string;
}

export interface PowerbankInfo {
  serial: string;
  timestamp: number;
  totalCapacity: number;
  remainingCapacity: number;
  cycles: number;
  status: number;
}

export interface SlotStatus {
  fill: number; // Bitmap of filled slots
  lock: number; // Bitmap of locked slots
}
