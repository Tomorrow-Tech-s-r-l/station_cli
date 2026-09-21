import {
  PB_STATUS_CUTOFF,
  PB_STATUS_CHARGING,
  LOW_VOLTAGE_THRESHOLD_MV,
} from "../../utils/constants";

/**
 * Calculates the reported power level percentage. This is the number the
 * fleet sees: the powerbank ships raw mAh and the station relays them without
 * arithmetic, so no percentage exists anywhere upstream of here.
 *
 * The base measurement mirrors the powerbank's own SoC block (see
 * P1TT2C-firmware/App/Src/modules/charge_module.c): the same integer-division
 * order, multiplying by 100 before dividing, and the same flooring of both
 * differences at zero so an inverted anchor pair cannot produce a negative
 * denominator.
 *
 * It deliberately does one thing the firmware does not. While the pack
 * reports PB_STATUS_CHARGING the denominator becomes whichever is larger of
 * avgCapacity (the pack's learned full-charge capacity, which tracks ageing)
 * and the calibrated span totalCharge - cutoffCharge. That caps a mid-charge
 * projection so it cannot overshoot before the charger declares the pack
 * full. The firmware has no equivalent because its own SoC value only drives
 * the discharge LED ladder and is never evaluated while charging — here the
 * value is reported in every state, so the ceiling is load-bearing.
 *
 * Firmware that does not report avgCapacity sends 0, in which case the
 * denominator is always the calibrated span.
 * @param currentCharge Current charge value (LTC2943_Status.acr_mAh on the powerbank)
 * @param totalCharge Total charge value (flashData.totalCap on the powerbank)
 * @param cutoffCharge Cutoff charge value (flashData.cutoffCap on the powerbank)
 * @param avgCapacity Learned average full-charge capacity (flashData.avgCap on the powerbank, 0 on firmware that does not report it)
 * @param status Raw powerbank firmware status byte (PB_STATUS_*), used to gate the avgCapacity ceiling to the CHARGING state only
 * @returns Power level percentage, clamped to [0, 100]. An out-of-range raw
 *          value is logged to stderr before clamping.
 */
export function calculatePowerLevel(
  currentCharge: number | string | undefined,
  totalCharge: number | string | undefined,
  cutoffCharge: number | string | undefined = 0,
  avgCapacity: number | string | undefined = 0,
  status: number | undefined = undefined
): number {
  const totalCap = parseInt(String(totalCharge)) || 0;
  const currentCap = parseInt(String(currentCharge)) || 0;
  const cutoffCap = parseInt(String(cutoffCharge)) || 0;
  const avgCap = parseInt(String(avgCapacity)) || 0;

  // measuredCap = (acr_mAh > cutoffCap) ? acr_mAh - cutoffCap : 0;
  const measuredCap = currentCap > cutoffCap ? currentCap - cutoffCap : 0;
  // prevCap = totalCap - cutoffCap;
  const prevCap = totalCap - cutoffCap;
  // socDenom = (status === CHARGING && avgCap > prevCap) ? avgCap : prevCap;
  const socDenom =
    status === PB_STATUS_CHARGING && avgCap > prevCap ? avgCap : prevCap;

  // soc = 100 * measuredCap / socDenom; (guarded against socDenom <= 0,
  // which the firmware doesn't need to guard against but JS should)
  const raw = socDenom > 0 ? Math.trunc((100 * measuredCap) / socDenom) : 0;

  // Clamp to [0, 100]. This is the percentage consumers read: the powerbank
  // ships raw mAh and the station relays them untouched, so whatever clamping
  // the pack does on-device never reaches this value.
  //
  // The clamp is a rail, not the computation: a pack whose firmware holds the
  // coulomb counter at the full anchor while CHARGED cannot exceed 100 here.
  // The rail covers packs running firmware without that cap, and it logs
  // rather than silently hiding the overshoot.
  //
  // prevCap above is a *signed* JS number: an inverted anchor pair (cutoffCap
  // greater than totalCap) makes socDenom negative, the socDenom > 0 guard
  // returns 0, and a full pack reports 0%. Keep both the guard and the clamp;
  // dropping either turns that case into a negative percentage.
  if (raw > 100 || raw < 0) {
    console.error(
      `[power_level] SoC out of range, clamping: raw=${raw} ` +
        `current=${currentCap} total=${totalCap} cutoff=${cutoffCap} avg=${avgCap}`
    );
  }
  return Math.max(0, Math.min(100, raw));
}

/**
 * Detects a low-voltage condition on a docked powerbank so the kiosk can warn
 * the operator. True when the firmware reports PB_STATUS_CUTOFF, or when the
 * LTC2943 pack voltage is known (> 0) and below the cutoff threshold.
 *
 * Note: the `slots` auto-charge logic only selects plugged-in packs
 * (PB_STATUS_PLUGGED_IN), so a CUTOFF/low-voltage pack is not picked up
 * automatically — recover it manually via `station_cli charge -i <index> -e true`.
 *
 * @param status Raw powerbank firmware status byte (PB_STATUS_*).
 * @param packVoltageMv Pack voltage in mV (0 = unknown / firmware too old).
 * @returns true when the pack has a low-voltage issue.
 */
export function isLowVoltage(
  status: number | undefined,
  packVoltageMv: number | undefined
): boolean {
  const mv = packVoltageMv ?? 0;
  return (
    status === PB_STATUS_CUTOFF ||
    (mv > 0 && mv < LOW_VOLTAGE_THRESHOLD_MV)
  );
}
