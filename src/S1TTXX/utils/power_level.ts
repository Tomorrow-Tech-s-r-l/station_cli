import {
  PB_STATUS_CUTOFF,
  PB_STATUS_CHARGING,
  LOW_VOLTAGE_THRESHOLD_MV,
} from "../../utils/constants";

/**
 * Calculates the power level percentage exactly as the powerbank firmware
 * does, line for line — see P1TT2C-firmware/App/Src/modules/charge_module.c,
 * the "Calculate State of Charge (SOC)" block. Same variable names, same
 * ternaries, same integer-division order (multiply by 100 before dividing),
 * so this always agrees with the value the powerbank itself would compute
 * from the same readings.
 *
 * While still charging (status === PB_STATUS_CHARGING), the denominator
 * (socDenom) is whichever is larger between avgCapacity (the pack's learned
 * average full-charge capacity, tracks ageing) and the previous cycle's
 * calibrated span (totalCharge - cutoffCharge) — this caps the mid-charge
 * projection so it doesn't overshoot 100% (BF-260512). Once the charger has
 * declared the pack full (any other status), totalCharge has just been
 * recalibrated to currentCharge, so measuredCap and prevCap are equal by
 * construction: using prevCap alone there lands SOC on exactly 100% instead
 * of being pulled down by a higher historical avgCapacity. On firmware that
 * doesn't report avgCapacity yet, it defaults to 0 and this reduces to the
 * old formula exactly.
 * @param currentCharge Current charge value (LTC2943_Status.acr_mAh on the powerbank)
 * @param totalCharge Total charge value (flashData.totalCap on the powerbank)
 * @param cutoffCharge Cutoff charge value (flashData.cutoffCap on the powerbank)
 * @param avgCapacity Learned average full-charge capacity (flashData.avgCap on the powerbank, 0 on old firmware)
 * @param status Raw powerbank firmware status byte (PB_STATUS_*), used to gate the avgCapacity ceiling to the CHARGING state only
 * @returns Power level percentage (not clamped to 100 while charging — see note above)
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
  return socDenom > 0 ? Math.trunc((100 * measuredCap) / socDenom) : 0;
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
