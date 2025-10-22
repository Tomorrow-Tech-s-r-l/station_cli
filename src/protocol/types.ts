// Buffer is a Node.js built-in, no import needed

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

// Firmware version response payload
export interface FirmwareResponsePayload {
  version: string;
}

// Model response payload
export interface ModelResponsePayload {
  model: string;
  boardCount: number;
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
  totalCharge: number;
  currentCharge: number;
  cutoffCharge: number;
  cycles: number;
  status: number;
}

export interface PowerBankServer {
  id: string;
  powerLevel: number;
}

export interface SlotsInfo {
  powerBank: PowerBankServer | null;
  isCharging: boolean;
  isLocked: boolean;
  index: number;
  state: string;
  disabled: boolean;
  boardAddress: number;
  slotIndex: number;
}

/**
 * Slot state
 */
export enum SlotState {
  available = "available",
  empty = "empty",
  unlock = "unlock",
  unknown = "unknown",
}

export enum SlotError {
  NONE = "none",
  STATUS_COMMAND_FAILED = "status_command_failed",
  SLOTS_COMMAND_FAILED = "slots_command_failed",
  INVALID_RESPONSE = "invalid_response",
  CONNECTION_ERROR = "connection_error",
}

export interface SlotErrorInfo {
  index: number;
  boardAddress: number;
  slotIndex: number;
  error: SlotError;
  message?: string;
}

export interface SlotsResponse {
  slots: SlotsInfo[];
  errors: SlotErrorInfo[];
  executionTimeMs: number;
  timestamp: string;
}
