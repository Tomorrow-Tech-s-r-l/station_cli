import { SLOT_INDEX_MAXIMUM, SLOT_INDEX_MINIMUM } from "../protocol/constants";

/**
 * Make validation on the enable input cli requests
 *
 * @param {string} value - Value provided by user
 * @returns {string} - Value provided by user after checking it's ok
 */
export function cliInputValidatorIndex(value: string): string {
  let index = parseInt(value);
  if (
    isNaN(index) ||
    index < SLOT_INDEX_MINIMUM ||
    index > SLOT_INDEX_MAXIMUM
  ) {
    throw new Error(
      `Index value must be between minimum ${SLOT_INDEX_MINIMUM} and maximum ${SLOT_INDEX_MAXIMUM}`
    );
  }
  return value;
}

/**
 * Make validation on the enable input cli requests
 *
 * @param {string} value - Value provided by user
 * @returns {string} - Value provided by user after checking it's ok
 */
export function cliInputValidatorEnable(value: string): string {
  if (value !== "true" && value !== "false") {
    throw new Error('Enable value must be either "true" or "false"');
  }
  return value;
}
