import { MAXIMUM_BOARD_ADDRESS } from "../protocol/constants";

export const SLOT_IS_LOCKED_DEFAULT_VALUE = true;
export const SLOT_IS_DISABLED_DEFAULT_VALUE = false;

export interface SlotMapping {
  boardAddress: number;
  slotInBoard: number;
  zeroBasedIndex: number;
}

/**
 * Maps a 1-based slot index (1-30) to board address and slot position
 *
 * Slot to board mapping:
 * - Slots 1-6   → Board 0, Slots 0-5
 * - Slots 7-12  → Board 1, Slots 0-5
 * - Slots 13-18 → Board 2, Slots 0-5
 * - Slots 19-24 → Board 3, Slots 0-5
 * - Slots 25-30 → Board 4, Slots 0-5
 *
 * @param slotIndex 1-based slot index (1-30)
 * @returns Object containing board address, slot position, and zero-based index
 * @throws Error if slot index is invalid
 */
export function mapSlotToBoard(slotIndex: number): SlotMapping {
  if (slotIndex < 1 || slotIndex > 30) {
    throw new Error("Slot index must be between 1 and 30");
  }

  const zeroBasedIndex = slotIndex - 1;
  const boardAddress = Math.floor(zeroBasedIndex / 6); // 6 slots per board
  const slotInBoard = zeroBasedIndex % 6; // 0-5 for slots within board

  if (boardAddress > MAXIMUM_BOARD_ADDRESS) {
    throw new Error(
      `Invalid slot index: ${slotIndex} (board ${boardAddress} exceeds maximum ${MAXIMUM_BOARD_ADDRESS})`
    );
  }

  return {
    boardAddress,
    slotInBoard,
    zeroBasedIndex,
  };
}

/**
 * Maps a board address and slot position to a 1-based slot index
 *
 * @param boardAddress Board address (0-4)
 * @param slotInBoard Slot position within board (0-5)
 * @returns 1-based slot index (1-30)
 * @throws Error if board address or slot position is invalid
 */
export function mapBoardToSlot(
  boardAddress: number,
  slotInBoard: number
): number {
  if (boardAddress < 0 || boardAddress > MAXIMUM_BOARD_ADDRESS) {
    throw new Error(
      `Board address must be between 0 and ${MAXIMUM_BOARD_ADDRESS}`
    );
  }

  if (slotInBoard < 0 || slotInBoard > 5) {
    throw new Error("Slot position must be between 0 and 5");
  }

  return boardAddress * 6 + slotInBoard + 1;
}
