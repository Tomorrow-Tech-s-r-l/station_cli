import {
  PB_STATUS_CUTOFF,
  LOW_VOLTAGE_THRESHOLD_MV,
} from "../../utils/constants";

/**
 * Calculates the power level percentage based on current and total charge
 * The cutoffCharge is subtracted from both values since currentCharge will not go below cutoffCharge
 * @param currentCharge Current charge value
 * @param totalCharge Total charge value
 * @param cutoffCharge Cutoff charge value (minimum charge level)
 * @returns Power level percentage (0-100)
 */
export function calculatePowerLevel(
  currentCharge: number | string | undefined,
  totalCharge: number | string | undefined,
  cutoffCharge: number | string | undefined = 0
): number {
  const total = parseInt(String(totalCharge)) || 0;
  const current = parseInt(String(currentCharge)) || 0;
  const cutoff = parseInt(String(cutoffCharge)) || 0;

  // Calculate usable charge (current - cutoff) and usable total (total - cutoff)
  const usableCharge = Math.max(0, current - cutoff);
  const usableTotal = total - cutoff;

  // Return 0 if usableTotal is 0 or negative
  return usableTotal > 0 ? Math.trunc((usableCharge / usableTotal) * 100) : 0;
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
