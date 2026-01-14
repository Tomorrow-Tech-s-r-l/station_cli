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
