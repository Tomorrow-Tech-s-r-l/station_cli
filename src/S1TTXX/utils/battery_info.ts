/**
 * Sanity check on the charge parameters a powerbank reports over CMD_STATUS,
 * and the matching pre-write check applied before we send new ones.
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

// Factory nameplate for the 4S pack (four 3500 mAh 18650 cells in series,
// 12.0 V empty to 16.8 V full — see LOW_VOLTAGE_THRESHOLD_MV).
//
// These are not capacities: they are coulomb-counter values, offset so that
// the counter reads DEFAULT_CUTOFF_CHARGE_MAH at 0% and never goes below it.
// The pack's usable capacity is the window between cutoff and total, which is
// why the numbers look far larger than the 3500 mAh the cells hold.
export const PACK_USABLE_CAPACITY_MAH = 3500;
export const DEFAULT_CUTOFF_CHARGE_MAH = 10625;
export const DEFAULT_TOTAL_CHARGE_MAH =
  DEFAULT_CUTOFF_CHARGE_MAH + PACK_USABLE_CAPACITY_MAH;

// State of charge written to a pack that has to be initialized or repaired.
// Deliberately low: it is an assumption, not a measurement, and a pack that
// believes it is emptier than it is will charge and re-learn its counter,
// whereas one that believes it is full never charges at all.
export const DEFAULT_CHARGE_PERCENT = 30;
export const DEFAULT_CURRENT_CHARGE_MAH =
  DEFAULT_CUTOFF_CHARGE_MAH +
  Math.round((DEFAULT_CHARGE_PERCENT / 100) * PACK_USABLE_CAPACITY_MAH);

// Smallest value we accept as a real capacity nameplate. Anything under this
// is a bad write (a zeroed field, a truncated value), not a small battery.
export const MIN_PLAUSIBLE_TOTAL_CHARGE_MAH = 1000;

// Smallest usable window we accept, mirroring BATTERY_CAP_MIN_SPAN in
// P1TT2C-firmware/App/Inc/config.h. The pack rejects a CMD_SET_BINFO whose
// span is under this and repairs such a pair at boot, because the SoC
// division degenerates below it. Matching the number here means the CLI
// refuses exactly what the pack would refuse, instead of discovering it from
// a RES_MALFORMED reply after some of the write has already landed.
export const MIN_CHARGE_SPAN_MAH = 100;

// How far above totalCharge a *reported* currentCharge may sit before we call
// the nameplate impossible.
//
// Overshoot at the top of charge is normal, not corruption. On a completed
// cycle the pack anchors its own capacity to the gauge — `flashData.totalCap =
// LTC2943_Status.acr_mAh` in charge_module.c — so a full pack parks exactly on
// total == current and the next sample lands on either side of the line. A
// station is mostly full packs waiting to be rented, so a zero-tolerance check
// fires on healthy hardware; each false fire rewrites a 100% pack's nameplate
// to DEFAULT_CHARGE_PERCENT.
//
// The band is BATTERY_CHARGED_HYST (the firmware's own "meaningfully below
// full" margin): inside it the pack is simply full, outside it the counter is
// reporting a charge the cells cannot hold, which does strand the pack at 100%
// and does need repairing.
export const CHARGE_OVERSHOOT_TOLERANCE_MAH = 200;

// The wire fields are uint16 (see SetBatteryInfoCommand's payload layout).
export const MAX_CHARGE_FIELD_MAH = 65535;

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
 * window, or when the pack believes it holds substantially more charge than
 * its own capacity.
 *
 * A pack sitting *below* its cutoff is not a fault — that is a normal deeply
 * discharged pack. Neither is one sitting just above its total: see
 * CHARGE_OVERSHOOT_TOLERANCE_MAH.
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
    total - cutoff >= MIN_CHARGE_SPAN_MAH &&
    current <= total + CHARGE_OVERSHOOT_TOLERANCE_MAH
  );
}

/**
 * Check a triple we are about to *write*, before any byte goes out.
 *
 * Stricter than isBatteryInfoValid, and deliberately so: that one judges what
 * a pack reports, where gauge drift is expected, while this one judges what we
 * are asking a pack to believe, where there is no reason to ask for anything
 * but a coherent nameplate. It is the CLI's half of the check the pack
 * firmware performs (CMD_SET_BINFO in uart_module.c) — without it the CLI
 * happily writes `cutoff >= total` to any pack whose firmware predates that
 * check, creating exactly the fault the `slots` repair exists to clean up.
 *
 * @returns null when the triple is safe to write, otherwise the reason.
 */
export function validateBatteryParams(
  params: Partial<BatteryChargeParams> | null | undefined
): string | null {
  const fields: Array<[string, unknown]> = [
    ["total charge", params?.totalCharge],
    ["current charge", params?.currentCharge],
    ["cutoff charge", params?.cutoffCharge],
  ];

  for (const [label, value] of fields) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return `${label} must be a whole number of mAh (got ${value})`;
    }
    if (value < 0 || value > MAX_CHARGE_FIELD_MAH) {
      return `${label} must be between 0 and ${MAX_CHARGE_FIELD_MAH} mAh (got ${value})`;
    }
  }

  const total = params!.totalCharge as number;
  const current = params!.currentCharge as number;
  const cutoff = params!.cutoffCharge as number;

  if (total < MIN_PLAUSIBLE_TOTAL_CHARGE_MAH) {
    return (
      `total charge ${total} mAh is below the smallest plausible nameplate ` +
      `(${MIN_PLAUSIBLE_TOTAL_CHARGE_MAH} mAh)`
    );
  }
  if (cutoff >= total) {
    return (
      `cutoff charge ${cutoff} mAh must be below total charge ${total} mAh; ` +
      `otherwise the pack reports 0% forever and never charges`
    );
  }
  if (total - cutoff < MIN_CHARGE_SPAN_MAH) {
    return (
      `the usable window total - cutoff is ${total - cutoff} mAh, below the ` +
      `${MIN_CHARGE_SPAN_MAH} mAh minimum the powerbank firmware accepts`
    );
  }
  if (current > total) {
    return (
      `current charge ${current} mAh cannot exceed total charge ${total} mAh`
    );
  }

  return null;
}

/** The parameter set written to a pack whose stored values are impossible. */
export function defaultBatteryParams(): BatteryChargeParams {
  return {
    totalCharge: DEFAULT_TOTAL_CHARGE_MAH,
    currentCharge: DEFAULT_CURRENT_CHARGE_MAH,
    cutoffCharge: DEFAULT_CUTOFF_CHARGE_MAH,
  };
}
