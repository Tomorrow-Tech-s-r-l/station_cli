import {
  PB_STATUS_CHARGING,
  PB_STATUS_PLUGGED_IN,
} from "../../utils/constants";

/**
 * Rank given to a powerbank still carrying impossible charge parameters after
 * `slots` tried to rewrite them — the write was refused, or it did not stick.
 * Such a pack stays a charging candidate (so a board holding nothing else
 * still charges it) but always loses to a pack we can account for: one that
 * never accepts the write would otherwise hold the board's single charging
 * slot forever and starve the other five.
 */
export const UNREPAIRABLE_PACK_RANK = Number.MAX_SAFE_INTEGER;

/** One slot of a board, as seen by the charging election. */
export interface ChargeCandidate {
  slotIndex: number;
  isPowerbankPresent: boolean;
  // Raw powerbank firmware status byte (PB_STATUS_*), undefined when the
  // status read failed.
  status?: number;
  // 0-100, from calculatePowerLevel. Meaningless when batteryInfoValid is
  // false, which is why it is not used for those packs.
  powerLevel: number;
  // False when the pack's stored charge parameters are impossible.
  batteryInfoValid: boolean;
  // True when `slots` successfully rewrote those parameters on this run.
  batteryInfoRepaired: boolean;
}

/**
 * Pick the single slot on a board that may charge
 * (MAXIMUM_POWERBANK_TO_CHARGE_PER_BOARD is 1).
 *
 * Priority 1: a powerbank already in PB_STATUS_CHARGING keeps the slot, so
 *   charging is not restarted on every poll.
 * Priority 2: otherwise the emptiest candidate wins, compared by power LEVEL
 *   rather than raw mAh so packs of different capacities are ranked fairly.
 *
 * Candidates are powerbanks reporting PB_STATUS_PLUGGED_IN, plus any pack
 * whose charge parameters are not valid, plus any pack whose parameters were
 * re-initialized on this run. Those last two groups matter: a pack with
 * impossible parameters decides it is full (PB_STATUS_IDLE) or cut off
 * against those same numbers, so its status is no evidence that it does not
 * need charging, and excluding it is what leaves a mis-initialized pack stuck
 * at 0% forever. A pack that was just repaired is included for the same
 * reason — its status byte still reflects the parameters it had a moment ago.
 * A pack in PB_STATUS_IDLE with sound, untouched parameters is excluded as
 * before: it really did finish charging.
 *
 * Ties go to the lowest slot index, so the choice is stable across polls.
 *
 * @param slots Every slot of one board.
 * @returns The slot index that should charge, or -1 when none should.
 */
export function electChargingSlot(slots: ChargeCandidate[]): number {
  let alreadyCharging = -1;
  for (const slot of slots) {
    if (
      slot.isPowerbankPresent &&
      slot.status === PB_STATUS_CHARGING &&
      (alreadyCharging === -1 || slot.slotIndex < alreadyCharging)
    ) {
      alreadyCharging = slot.slotIndex;
    }
  }
  if (alreadyCharging !== -1) return alreadyCharging;

  let best: { slotIndex: number; rank: number } | null = null;

  for (const slot of slots) {
    const isCandidate =
      slot.isPowerbankPresent &&
      slot.status !== undefined &&
      (slot.status === PB_STATUS_PLUGGED_IN ||
        !slot.batteryInfoValid ||
        slot.batteryInfoRepaired);
    if (!isCandidate) continue;

    // Ranking uses the parameters as they stand *after* any repair. A pack
    // still carrying impossible parameters here is one we could not fix —
    // either the write was refused or it did not stick — so its power level
    // means nothing and it goes to the back of the queue rather than holding
    // the board against packs we can account for.
    const rank = slot.batteryInfoValid
      ? slot.powerLevel
      : UNREPAIRABLE_PACK_RANK;

    if (
      best === null ||
      rank < best.rank ||
      (rank === best.rank && slot.slotIndex < best.slotIndex)
    ) {
      best = { slotIndex: slot.slotIndex, rank };
    }
  }

  return best === null ? -1 : best.slotIndex;
}
