/**
 * Sanity checks on the charge parameters a powerbank reports over
 * CMD_STATUS (and that CMD_SET_INFO_BATTERY writes into it).
 *
 * These three numbers are pure bookkeeping held by the pack firmware: nothing
 * measures them, they are whatever was last written by `initialize-powerbank`
 * plus the coulomb counter's drift. When they are impossible, two things break
 * at once:
 *
 *   1. `calculatePowerLevel` pins the pack at 0% forever, because the usable
 *      window (totalCharge - cutoffCharge) is empty or negative.
 *   2. The pack's own status byte becomes untrustworthy — it decides it is
 *      "full" (PB_STATUS_IDLE) against the same bad totalCharge, and the
 *      `slots` auto-charge election skips IDLE packs by design. The pack then
 *      never charges again and sits at 0% until an operator re-initializes it.
 *
 * So a pack failing these checks is re-initialized with the factory defaults
 * below and stays a charge candidate in the meantime.
 */

// Factory nameplate, matching the `initialize-powerbank` defaults and
// tests/initialize_powerbank_all.sh. A pack whose stored parameters are
// impossible is rewritten with exactly these values.
export const DEFAULT_TOTAL_CHARGE_MAH = 13925;
export const DEFAULT_CURRENT_CHARGE_MAH = 11625;
export const DEFAULT_CUTOFF_CHARGE_MAH = 10625;

// Smallest value we accept as a real capacity nameplate. Anything under this
// is a bad write (a zeroed field, a truncated value), not a small battery.
export const MIN_PLAUSIBLE_TOTAL_CHARGE_MAH = 1000;

/**
 * Ways the stored parameters can be impossible. Reported verbatim in the
 * slots/status JSON as `batteryInfoFaults`, so these strings are a contract:
 * treat them as stable tokens.
 */
export type BatteryInfoFault =
  // totalCharge is zero or too small to be a real capacity.
  | "total_implausible"
  // Empty usable window: powerLevel can only ever read 0%.
  | "cutoff_ge_total"
  // The pack believes it holds more than its own capacity, so it terminates
  // charging (and reports itself full) the moment it is plugged in.
  | "current_gt_total"
  // Initialization only: writing a charge below the cutoff is nonsense. A
  // *running* pack may legitimately sit below cutoff when deeply discharged,
  // which is why this is not part of checkBatteryInfo.
  | "current_lt_cutoff";

export interface BatteryChargeParams {
  totalCharge: number;
  currentCharge: number;
  cutoffCharge: number;
}

/** Coerce a reported field to mAh; anything unparseable counts as 0. */
function toMah(value: number | string | undefined | null): number {
  const parsed = parseInt(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Check the parameters of a docked pack. Empty array means they are usable.
 *
 * @param params Charge parameters as reported by CMD_STATUS.
 * @returns Every fault found, in a stable order.
 */
export function checkBatteryInfo(
  params: Partial<BatteryChargeParams> | null | undefined
): BatteryInfoFault[] {
  const total = toMah(params?.totalCharge);
  const current = toMah(params?.currentCharge);
  const cutoff = toMah(params?.cutoffCharge);

  const faults: BatteryInfoFault[] = [];
  if (total < MIN_PLAUSIBLE_TOTAL_CHARGE_MAH) faults.push("total_implausible");
  if (cutoff >= total) faults.push("cutoff_ge_total");
  if (current > total) faults.push("current_gt_total");
  return faults;
}

/**
 * True when the parameters of a docked pack are usable.
 *
 * @param params Charge parameters as reported by CMD_STATUS.
 */
export function isBatteryInfoValid(
  params: Partial<BatteryChargeParams> | null | undefined
): boolean {
  return checkBatteryInfo(params).length === 0;
}

/**
 * Check parameters that are about to be *written* to a pack. Stricter than
 * {@link checkBatteryInfo}: a fresh nameplate must also place the current
 * charge at or above the cutoff.
 *
 * @param params Charge parameters to write.
 * @returns Every fault found, in a stable order.
 */
export function checkInitialBatteryParams(
  params: BatteryChargeParams
): BatteryInfoFault[] {
  const faults = checkBatteryInfo(params);
  if (toMah(params.currentCharge) < toMah(params.cutoffCharge)) {
    faults.push("current_lt_cutoff");
  }
  return faults;
}

/**
 * The parameter set written to a pack whose stored values are impossible.
 * A fresh object each call, so callers may mutate it freely.
 */
export function defaultBatteryParams(): BatteryChargeParams {
  return {
    totalCharge: DEFAULT_TOTAL_CHARGE_MAH,
    currentCharge: DEFAULT_CURRENT_CHARGE_MAH,
    cutoffCharge: DEFAULT_CUTOFF_CHARGE_MAH,
  };
}

/**
 * Human-readable one-liner for logs.
 *
 * @param faults Faults from checkBatteryInfo / checkInitialBatteryParams.
 * @param params The offending parameters.
 */
export function describeBatteryFaults(
  faults: BatteryInfoFault[],
  params: Partial<BatteryChargeParams> | null | undefined
): string {
  return (
    `${faults.join(", ")} ` +
    `(total=${toMah(params?.totalCharge)} mAh, ` +
    `current=${toMah(params?.currentCharge)} mAh, ` +
    `cutoff=${toMah(params?.cutoffCharge)} mAh)`
  );
}
