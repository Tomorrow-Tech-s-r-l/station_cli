import { BaseCommand } from "./base";
import {
  SerialMessage,
  CommandResponse,
  PowerbankInfo,
} from "../../protocol/types";
import {
  CMD_SET_INFO_PWB,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";
import {
  DEFAULT_TOTAL_CHARGE_MAH,
  DEFAULT_CURRENT_CHARGE_MAH,
  DEFAULT_CUTOFF_CHARGE_MAH,
  validateBatteryParams,
} from "../../utils/battery_info";
import { SetBatteryInfoCommand } from "./set_battery_info";
import { StatusCommand } from "./status";
// Buffer is a Node.js built-in, no import needed

export const SERIAL_NUMBER_LENGTH = 10;

/**
 * Thrown when a request is refused before a single byte has reached the pack,
 * so the caller can state that the powerbank is untouched rather than leaving
 * the operator to guess how far a failed initialize got.
 */
export class NothingWrittenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingWrittenError";
  }
}

interface InitializePowerbankParams {
  serialNumber: string;
  timestamp?: number;
  cycles?: number;
  totalCharge?: number;
  currentCharge?: number;
  cutoffCharge?: number;
}

/** What was sent to the pack, resolved defaults included. */
export interface InitializePowerbankWritten {
  serialNumber: string;
  manufacturingTimestamp: number;
  cycles: number;
  totalCharge: number;
  currentCharge: number;
  cutoffCharge: number;
}

/**
 * The shape JSON-encoded into the returned CommandResponse.data, so the CLI
 * layer can report what the pack actually holds rather than what was asked
 * for, and can say precisely which half of the write landed when one fails.
 */
export interface InitializePowerbankOutcome {
  stage: "battery-info" | "powerbank-info" | "complete";
  batteryInfoWritten: boolean;
  powerbankInfoWritten: boolean;
  written: InitializePowerbankWritten;
  verified: PowerbankInfo | null;
  verificationError: string | null;
}

/**
 * Writes a powerbank's identity (CMD_SET_INFO_PWB) and battery nameplate
 * (CMD_SET_INFO_BATTERY).
 *
 * Two separate firmware commands, each committing to flash on its own, so
 * there is no transaction to lean on. Two things stand in for one:
 *
 *   1. Every parameter is checked before the first byte goes out, so a
 *      malformed request is refused with nothing written.
 *   2. The nameplate is written first and the identity second. A pack's serial
 *      is the key rentals are tracked by, and a refusal the CLI could not
 *      predict (older station firmware, a flash failure, a link drop) must not
 *      be able to rename a pack. Capacities are recoverable — `slots` repairs
 *      them on the next poll — a silently renamed pack is not.
 */
export class InitializePowerbankCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number,
    params: InitializePowerbankParams
  ): Promise<CommandResponse> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new NothingWrittenError(
        `Slot address must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }

    if (
      !params.serialNumber ||
      params.serialNumber.length !== SERIAL_NUMBER_LENGTH
    ) {
      throw new NothingWrittenError(
        `Serial number must be exactly ${SERIAL_NUMBER_LENGTH} characters`
      );
    }

    // Resolve defaults with ?? rather than ||: 0 is a legitimate value for a
    // timestamp and a cycle count, and for a charge field it is a value the
    // check below has to be able to reject. With || an explicit 0 silently
    // became the default, and the caller was told its 0 had been written.
    const written: InitializePowerbankWritten = {
      serialNumber: params.serialNumber,
      manufacturingTimestamp:
        params.timestamp ?? Math.floor(Date.now() / 1000),
      cycles: params.cycles ?? 0,
      totalCharge: params.totalCharge ?? DEFAULT_TOTAL_CHARGE_MAH,
      currentCharge: params.currentCharge ?? DEFAULT_CURRENT_CHARGE_MAH,
      cutoffCharge: params.cutoffCharge ?? DEFAULT_CUTOFF_CHARGE_MAH,
    };

    if (
      !Number.isInteger(written.cycles) ||
      written.cycles < 0 ||
      written.cycles > 65535
    ) {
      throw new NothingWrittenError(
        `Cycles must be between 0 and 65535 (got ${written.cycles})`
      );
    }
    if (
      !Number.isInteger(written.manufacturingTimestamp) ||
      written.manufacturingTimestamp < 0 ||
      written.manufacturingTimestamp > 0xffffffff
    ) {
      throw new NothingWrittenError(
        `Manufacturing timestamp must be a Unix time in seconds ` +
          `(got ${written.manufacturingTimestamp})`
      );
    }

    // Checked here as well as inside SetBatteryInfoCommand, because here it
    // has to happen before CMD_SET_INFO_PWB rather than merely before
    // CMD_SET_INFO_BATTERY.
    const invalid = validateBatteryParams(written);
    if (invalid) {
      throw new NothingWrittenError(
        `Refusing to initialize powerbank: ${invalid}`
      );
    }

    const outcome: InitializePowerbankOutcome = {
      stage: "battery-info",
      batteryInfoWritten: false,
      powerbankInfoWritten: false,
      written,
      verified: null,
      verificationError: null,
    };

    // Step 1: battery nameplate (opcode 0x09). The pack firmware validates
    // this one and can answer RES_MALFORMED; going first means such a refusal
    // leaves the pack's identity exactly as it was.
    const batteryResponse = await new SetBatteryInfoCommand(
      this.serialService
    ).execute(boardAddress, slotAddress, {
      totalCharge: written.totalCharge,
      currentCharge: written.currentCharge,
      cutoffCharge: written.cutoffCharge,
    });

    if (!batteryResponse.success) {
      return { ...batteryResponse, data: encode(outcome) };
    }
    outcome.batteryInfoWritten = true;
    outcome.stage = "powerbank-info";

    // Step 2: identity (opcode 0x08).
    // Payload: [slotId, serial(10), timestamp(4), cycles(2)] = 17 bytes
    const infoPBData = Buffer.alloc(17);
    infoPBData.writeUInt8(slotAddress, 0);
    infoPBData.write(written.serialNumber, 1, SERIAL_NUMBER_LENGTH, "utf8");
    infoPBData.writeUInt32LE(written.manufacturingTimestamp, 11);
    infoPBData.writeUInt16LE(written.cycles, 15);

    const infoPBMessage: SerialMessage = {
      boardAddress,
      command: CMD_SET_INFO_PWB,
      data: infoPBData,
    };

    const infoPBResponse = await this.executeCommand(infoPBMessage);
    if (!infoPBResponse.success) {
      return { ...infoPBResponse, data: encode(outcome) };
    }
    outcome.powerbankInfoWritten = true;
    outcome.stage = "complete";

    // Step 3: read the pack back. The write commands acknowledge acceptance,
    // not content, so the values reported to the caller are the pack's own —
    // a confirmation rather than an echo of the request.
    try {
      const statusResponse = await new StatusCommand(this.serialService).execute(
        boardAddress,
        slotAddress
      );
      if (statusResponse.success && statusResponse.data.length > 0) {
        outcome.verified = JSON.parse(
          statusResponse.data.toString()
        ) as PowerbankInfo;
      } else {
        outcome.verificationError = `read-back failed with status ${statusResponse.status}`;
      }
    } catch (error) {
      outcome.verificationError =
        error instanceof Error ? error.message : "Unknown error";
    }

    return { ...infoPBResponse, data: encode(outcome) };
  }
}

function encode(outcome: InitializePowerbankOutcome): Buffer {
  return Buffer.from(JSON.stringify(outcome));
}
