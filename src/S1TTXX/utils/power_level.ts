/**
 * Calculates the power level percentage based on current and total charge
 * @param currentCharge Current charge value
 * @param totalCharge Total charge value
 * @returns Power level percentage (0-100)
 */
export function calculatePowerLevel(
  currentCharge: number | string | undefined,
  totalCharge: number | string | undefined
): number {
  const total = parseInt(String(totalCharge)) || 0;
  const current = parseInt(String(currentCharge)) || 0;
  return total > 0 ? Math.trunc((current / total) * 100) : 0;
}
