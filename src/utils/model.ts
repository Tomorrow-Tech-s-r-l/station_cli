import {
  MAXIMUM_BOARD_ADDRESS_S0TT,
  MAXIMUM_BOARD_ADDRESS_S1TT6,
  MAXIMUM_BOARD_ADDRESS_S1TT30,
  SLOT_INDEX_MAXIMUM_S1TT6,
  SLOT_INDEX_MAXIMUM_S1TT30,
  SLOT_INDEX_MAXIMUM_S0TT6,
  SLOT_INDEX_MAXIMUM_S0TT12,
  SLOT_INDEX_MAXIMUM_S0TT18,
} from "./constants";
// Runtime mode configuration for station CLI
// Modes:
// - S1TT30: 5 boards (0..4), 30 slots (1..30)
// - S1TT6:  1 board (0),     6 slots (1..6)
// - S0TT6:  S0TTXX gateway (NETCHECK), 6 slots  (1..6)
// - S0TT12: S0TTXX gateway (NETCHECK), 12 slots (1..12)
// - S0TT18: S0TTXX gateway (NETCHECK), 18 slots (1..18)
export type StationModel =
  | "S1TT30"
  | "S1TT6"
  | "S0TT6"
  | "S0TT12"
  | "S0TT18";

let currentModel: StationModel = "S1TT30";

export function setModel(model: StationModel): void {
  currentModel = model;
}

export function getModel(): StationModel {
  return currentModel;
}

/** True for any S0TTXX gateway variant. */
export function isS0TTModel(model: StationModel = currentModel): boolean {
  return model === "S0TT6" || model === "S0TT12" || model === "S0TT18";
}

export function getSlotIndexMinimum(): number {
  // Same minimum across modes
  return 1;
}

export function getSlotIndexMaximum(): number {
  switch (currentModel) {
    case "S0TT6":
      return SLOT_INDEX_MAXIMUM_S0TT6;
    case "S0TT12":
      return SLOT_INDEX_MAXIMUM_S0TT12;
    case "S0TT18":
      return SLOT_INDEX_MAXIMUM_S0TT18;
    case "S1TT6":
      return SLOT_INDEX_MAXIMUM_S1TT6;
    case "S1TT30":
      return SLOT_INDEX_MAXIMUM_S1TT30;
    default:
      return SLOT_INDEX_MAXIMUM_S1TT30;
  }
}

export function getMaximumBoardAddress(): number {
  // Board addresses are 0-based
  switch (currentModel) {
    case "S1TT6":
      return MAXIMUM_BOARD_ADDRESS_S1TT6;
    case "S0TT6":
    case "S0TT12":
    case "S0TT18":
      return MAXIMUM_BOARD_ADDRESS_S0TT;
    case "S1TT30":
      return MAXIMUM_BOARD_ADDRESS_S1TT30;
    default:
      return MAXIMUM_BOARD_ADDRESS_S1TT30;
  }
}
