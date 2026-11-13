import {
  MAXIMUM_POWERBANK_TO_CHARGE_PER_BOARD,
  PB_STATUS_CHARGING,
  PB_STATUS_PLUGGED_IN,
} from "../../utils/constants";

/** One slot of one board, as `slots` sees it after reading the board. */
export interface ChargeCandidate {
  slotIndex: number;
  isPowerbankPresent: boolean;
  powerBankInfo: any;
  powerLevel: number;
  packVoltageMv?: number;
  needsCharging: boolean;
}

export interface ChargeScheduleOptions {
  /**
   * False when the operator switched charging off for this station
   * (`slots --no-charge`, driven by the kiosk's `chargingEnabled` setting).
   * No slot is armed, so the caller sends CMD_SET_CHARGE=0 to every docked
   * pack: the pack charger stays off until the host arms it, so this stops
   * all charging on the board within one scan.
   */
  chargingEnabled: boolean;
}

/**
 * Which slot of one board (its index within the board) should charge after
 * this scan, or -1 for none. Every other docked pack gets CMD_SET_CHARGE=0.
 */
export function selectChargingSlot(
  boardSlots: ChargeCandidate[],
  options: ChargeScheduleOptions = { chargingEnabled: true }
): number {
  if (!options.chargingEnabled) return -1;

  // Phase 2: Determine which slot (if any) should charge
  // Rule: Only ONE powerbank per board can charge at a time
  // Priority 1: Keep powerbanks that are already charging (PB_STATUS_CHARGING)
  // Priority 2: If no powerbank is charging, charge the one with lowest currentCharge among PB_STATUS_PLUGGED_IN
  // Note: Powerbanks in PB_STATUS_IDLE (finished charging) are excluded from charging
  let chargingSlotIndex = -1;

  // The one-per-board rule is enforced structurally: chargingSlotIndex
  // holds a single slot, so the constant is never read by the
  // selection logic. Assert the two agree, so raising the constant
  // above 1 fails loudly here instead of being silently ignored.
  if (MAXIMUM_POWERBANK_TO_CHARGE_PER_BOARD !== 1) {
    throw new Error(
      "MAXIMUM_POWERBANK_TO_CHARGE_PER_BOARD is " +
        MAXIMUM_POWERBANK_TO_CHARGE_PER_BOARD +
        " but the selection logic below can only arm one slot per board"
    );
  }

  // A pack reporting CHARGING may keep the slot, but not
  // unconditionally: re-confirming whichever slot reports CHARGING
  // with no ceiling, latch or timer lets a pack whose status is stuck
  // at CHARGING pin the board's only charging slot indefinitely and
  // starve the other five.
  //
  // Two independent release conditions, both computable from one poll
  // (this command is one-shot; there is no cross-run state to lean on):
  //   1. needsCharging — powerLevel < MAXIMUM_POWER_LEVEL.
  //   2. the coulomb counter has reached or passed the pack's own full
  //      anchor. On firmware without the ACR cap the integrator keeps
  //      climbing past totalCharge while the charger tops off a pack
  //      that is already full, so currentCharge >= totalCharge means
  //      "stop".
  const stillNeedsCharge = (slot: ChargeCandidate) => {
    if (!slot.needsCharging) return false;
    const currentCharge = parseInt(slot.powerBankInfo?.currentCharge) || 0;
    const totalCharge = parseInt(slot.powerBankInfo?.totalCharge) || 0;
    if (totalCharge > 0 && currentCharge >= totalCharge) return false;
    return true;
  };

  // First, keep a powerbank that is charging AND still needs to be
  for (const slot of boardSlots) {
    if (
      slot.isPowerbankPresent &&
      slot.powerBankInfo &&
      slot.powerBankInfo.status === PB_STATUS_CHARGING &&
      stillNeedsCharge(slot)
    ) {
      chargingSlotIndex = slot.slotIndex;
      break;
    }
  }

  // If no powerbank is charging, charge the emptiest PB_STATUS_PLUGGED_IN pack:
  // lowest powerLevel, ties broken by the lowest raw currentCharge.
  // Exclude powerbanks that are in PB_STATUS_IDLE (finished charging) - they should not be charged again
  //
  // Ranked by the percentage, not the raw counter: currentCharge is
  // a coulomb-counter value relative to each pack's OWN anchors, so
  // comparing it across packs is meaningless. Ranking on it let a
  // healthy pack at 10647 mAh (a few %) beat packs frozen at 11674
  // reading 0% every scan, which then never got a turn.
  if (chargingSlotIndex === -1) {
    let lowestChargeSlot: {
      slotIndex: number;
      powerLevel: number;
      currentCharge: number;
    } | null = null;

    for (const slot of boardSlots) {
      if (
        slot.isPowerbankPresent &&
        slot.powerBankInfo &&
        slot.powerBankInfo.status === PB_STATUS_PLUGGED_IN
      ) {
        const powerLevel = slot.powerLevel;
        const currentCharge = slot.powerBankInfo.currentCharge || 0;
        if (
          lowestChargeSlot === null ||
          powerLevel < lowestChargeSlot.powerLevel ||
          (powerLevel === lowestChargeSlot.powerLevel &&
            currentCharge < lowestChargeSlot.currentCharge)
        ) {
          lowestChargeSlot = {
            slotIndex: slot.slotIndex,
            powerLevel,
            currentCharge,
          };
        }
      }
    }

    if (lowestChargeSlot !== null) {
      chargingSlotIndex = lowestChargeSlot.slotIndex;
    }
  }

  return chargingSlotIndex;
}
