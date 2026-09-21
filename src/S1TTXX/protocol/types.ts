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
  // Pack voltage in mV (LTC2943 vtr). 0 = unknown or firmware too old.
  // Used to detect deeply-discharged packs (status==CUTOFF, vtr near 0V
  // typically means a tripped BMS that needs a recovery charge cycle).
  packVoltageMv: number;
}

export interface PowerBankServer {
  id: string;
  powerLevel: number;
  // Raw powerbank firmware status byte. See PB_STATUS_* in utils/constants.
  status?: number;
  // Pack voltage in mV from the LTC2943. 0 = unknown / old firmware.
  packVoltageMv?: number;
  // True when the pack has a low-voltage issue: firmware reports
  // PB_STATUS_CUTOFF (5), or the LTC2943 pack voltage is below the cutoff
  // threshold. Surfaced so the kiosk can warn the operator. A CUTOFF pack is
  // skipped by the `slots` auto-charge logic (which only charges plugged-in
  // packs), so recovery is started manually via `station_cli charge`.
  lowVoltage?: boolean;
}

export interface SlotsInfo {
  powerBank: PowerBankServer | null;
  isPowerbankPresent: boolean;
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
