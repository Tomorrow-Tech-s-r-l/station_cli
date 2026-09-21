/**
 * Sanity check on the charge parameters a powerbank reports over CMD_STATUS.
 *
 * These three numbers are bookkeeping held by the pack firmware, not
 * measurements: they are whatever was last written by `initialize-powerbank`,
 * plus the coulomb counter's drift. When they are impossible the pack is lost
 * twice over — `calculatePowerLevel` pins it at 0% because the usable window
 * (totalCharge - cutoffCharge) is empty, and the pack decides it is full
 * against the same bad totalCharge, so it reports PB_STATUS_IDLE and the
 * `slots` auto-charge logic skips it. It then never charges again.
 *
 * `slots` rewrites the parameters of a pack that fails this check with the
 * defaults below, so it charges normally again.
 */

// Factory nameplate, matching the `initialize-powerbank` defaults and
// tests/initialize_powerbank_all.sh.
export const DEFAULT_TOTAL_CHARGE_MAH = 13925;
export const DEFAULT_CURRENT_CHARGE_MAH = 11625;
export const DEFAULT_CUTOFF_CHARGE_MAH = 10625;

// Smallest value we accept as a real capacity nameplate. Anything under this
// is a bad write (a zeroed field, a truncated value), not a small battery.
export const MIN_PLAUSIBLE_TOTAL_CHARGE_MAH = 1000;

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
 * True when a docked pack's stored charge parameters are usable. False when
 * the capacity is missing or far too small, when the cutoff leaves no usable
 * window, or when the pack believes it holds more than its own capacity.
 *
 * A pack sitting *below* its cutoff is not a fault — that is a normal deeply
 * discharged pack.
 *
 * @param params Charge parameters as reported by CMD_STATUS.
 */
export function isBatteryInfoValid(
  params: Partial<BatteryChargeParams> | null | undefined
): boolean {
  const total = toMah(params?.totalCharge);
  const current = toMah(params?.currentCharge);
  const cutoff = toMah(params?.cutoffCharge);

  return (
    total >= MIN_PLAUSIBLE_TOTAL_CHARGE_MAH &&
    cutoff < total &&
    current <= total
  );
}

/** The parameter set written to a pack whose stored values are impossible. */
export function defaultBatteryParams(): BatteryChargeParams {
  return {
    totalCharge: DEFAULT_TOTAL_CHARGE_MAH,
    currentCharge: DEFAULT_CURRENT_CHARGE_MAH,
    cutoffCharge: DEFAULT_CUTOFF_CHARGE_MAH,
  };
}
