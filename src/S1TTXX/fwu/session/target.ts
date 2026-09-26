import {
  CMD_FWU_ENTER_CODE,
  CMD_FWU_HELLO_CODE,
  CMD_FWU_BEGIN_CODE,
  CMD_FWU_DATA_CODE,
  CMD_FWU_END_CODE,
  CMD_FWU_ABORT_CODE,
  CMD_FWU_EXIT_CODE,
  CMD_PB_ENTER_BOOT_CODE,
  CMD_PB_FWU_HELLO_CODE,
  CMD_PB_FWU_BEGIN_CODE,
  CMD_PB_FWU_DATA_CODE,
  CMD_PB_FWU_END_CODE,
  CMD_PB_FWU_ABORT_CODE,
  CMD_PB_FWU_EXIT_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";

/**
 * Everything that differs between flashing a station board and flashing a
 * powerbank, in one place.
 *
 * The two firmware-update protocols are the same protocol: identical step
 * order, identical payload layouts, identical status codes. They differ only in
 * opcodes and in addressing — a powerbank frame carries its slot as a leading
 * byte, a station frame carries nothing extra. Capturing those differences as
 * data lets one state machine (`session.ts`) and one encoder (`wire.ts`) serve
 * both, so a protocol fix can no longer land in one path and be forgotten in
 * the other.
 *
 * The naming fields below are not cosmetic. `stages` feed the `error.stage`
 * field of the CLI's JSON output, which the kiosk app parses and logs, so they
 * are part of the cross-repo contract and are kept byte-identical to what each
 * orchestrator emitted before they were unified.
 */

export type FwuStep = "enter" | "hello" | "begin" | "data" | "end" | "abort" | "exit";

export interface FwuTarget {
  kind: "station" | "powerbank";
  boardAddress: number;
  /** Slot within the board for a powerbank; null for a station board. */
  slotInBoard: number | null;
  /** Opcode for each step. */
  opcodes: Record<FwuStep, number>;
  /** Prepended to every request payload: `[slot]` for a powerbank, nothing for a station. */
  prefix: Buffer;
  /** Value of `error.stage` when a step fails. Part of the JSON contract. */
  stages: Record<FwuStep, string>;
  /** Command name used in host-side validation errors, e.g. `FWU_DATA`. */
  dataCommandName: string;
  /** Tag for verbose progress lines. */
  logTag: string;
  /** Step names used in verbose progress lines. */
  stepLabels: Record<FwuStep, string>;
  /** How the device is identified in verbose progress lines. */
  addressLabel: string;
  /** Subject of the V-19 guard message, e.g. "Station returned …". */
  deviceNoun: string;
  /** Warning printed when the bootloader's protocol version is unexpected. */
  helloVersionWarning(major: number, minor: number, expMajor: number, expMinor: number): string;
}

/** A station board, addressed by its PB4..PB7 DIP-switch address. */
export function stationTarget(boardAddress: number): FwuTarget {
  return {
    kind: "station",
    boardAddress,
    slotInBoard: null,
    opcodes: {
      enter: CMD_FWU_ENTER_CODE,
      hello: CMD_FWU_HELLO_CODE,
      begin: CMD_FWU_BEGIN_CODE,
      data: CMD_FWU_DATA_CODE,
      end: CMD_FWU_END_CODE,
      abort: CMD_FWU_ABORT_CODE,
      exit: CMD_FWU_EXIT_CODE,
    },
    prefix: Buffer.alloc(0),
    stages: {
      enter: "FWU_ENTER",
      hello: "FWU_HELLO",
      begin: "FWU_BEGIN",
      data: "FWU_DATA",
      end: "FWU_END",
      abort: "FWU_ABORT",
      exit: "FWU_EXIT",
    },
    dataCommandName: "FWU_DATA",
    logTag: "[STATION-FWU]",
    stepLabels: {
      enter: "fwu-enter",
      hello: "fwu-hello",
      begin: "fwu-begin",
      data: "fwu-data",
      end: "fwu-end",
      abort: "fwu-abort",
      exit: "fwu-exit",
    },
    addressLabel: `board=${boardAddress}`,
    deviceNoun: "Station",
    helloVersionWarning: (major, minor, expMajor, expMinor) =>
      `[FWU] bootloader version ${major}.${minor} ` +
      `differs from host expectation ${expMajor}.${expMinor} ` +
      `(V-40). Proceeding; update station_cli if FWU breaks.`,
  };
}

/**
 * A powerbank docked in `slotInBoard` (0-5) of board `boardAddress`.
 *
 * Throws on an out-of-range slot, before anything reaches the wire — the same
 * guard, with the same message, every powerbank command applied individually.
 */
export function powerbankTarget(boardAddress: number, slotInBoard: number): FwuTarget {
  if (slotInBoard < 0 || slotInBoard > MAXIMUM_SLOT_ADDRESS) {
    throw new Error(`Slot index must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`);
  }
  return {
    kind: "powerbank",
    boardAddress,
    slotInBoard,
    opcodes: {
      enter: CMD_PB_ENTER_BOOT_CODE,
      hello: CMD_PB_FWU_HELLO_CODE,
      begin: CMD_PB_FWU_BEGIN_CODE,
      data: CMD_PB_FWU_DATA_CODE,
      end: CMD_PB_FWU_END_CODE,
      abort: CMD_PB_FWU_ABORT_CODE,
      exit: CMD_PB_FWU_EXIT_CODE,
    },
    prefix: Buffer.from([slotInBoard]),
    stages: {
      enter: "PB_ENTER_BOOT",
      hello: "PB_FWU_HELLO",
      begin: "PB_FWU_BEGIN",
      data: "PB_FWU_DATA",
      end: "PB_FWU_END",
      abort: "PB_FWU_ABORT",
      exit: "PB_FWU_EXIT",
    },
    dataCommandName: "PB_FWU_DATA",
    logTag: "[FWU]",
    stepLabels: {
      enter: "pb-enter-boot",
      hello: "pb-fwu-hello",
      begin: "pb-fwu-begin",
      data: "pb-fwu-data",
      end: "pb-fwu-end",
      abort: "pb-fwu-abort",
      exit: "pb-fwu-exit",
    },
    addressLabel: `board=${boardAddress}, slot=${slotInBoard}`,
    deviceNoun: "Powerbank",
    helloVersionWarning: (major, minor, expMajor, expMinor) =>
      `[PB-FWU] powerbank BL version ${major}.${minor} ` +
      `differs from host expectation ${expMajor}.${expMinor} ` +
      `(V-40, slot ${slotInBoard}). Proceeding; update station_cli if PB FWU breaks.`,
  };
}
