import {
  MAXIMUM_BOARD_ADDRESS_S0RU6,
  MAXIMUM_BOARD_ADDRESS_S1TT6,
  MAXIMUM_BOARD_ADDRESS_S1TT30,
  SLOT_INDEX_MAXIMUM_S1TT6,
  SLOT_INDEX_MAXIMUM_S0RU6,
  SLOT_INDEX_MAXIMUM_S1TT30,
} from "./constants";
// Runtime mode configuration for station CLI
// Modes:
// - S1TT30: 5 boards (0..4), 30 slots (1..30)
// - S1TT6:  1 board (0),     6 slots (1..6)
// - S0RU6:  S0RUXX protocol, 6 slots (1..6)
export type StationModel = "S1TT30" | "S1TT6" | "S0RU6";

let currentModel: StationModel = "S1TT30";

export function setModel(model: StationModel): void {
  currentModel = model;
}

export function getModel(): StationModel {
  return currentModel;
}

export function getSlotIndexMinimum(): number {
  // Same minimum across modes
  return 1;
}

export function getSlotIndexMaximum(): number {
  switch (currentModel) {
    case "S0RU6":
      return SLOT_INDEX_MAXIMUM_S0RU6;
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
    case "S0RU6":
      return MAXIMUM_BOARD_ADDRESS_S0RU6;
    case "S1TT30":
      return MAXIMUM_BOARD_ADDRESS_S1TT30;
    default:
      return MAXIMUM_BOARD_ADDRESS_S1TT30;
  }
}
