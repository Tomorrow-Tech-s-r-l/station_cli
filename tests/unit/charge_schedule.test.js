// Unit tests for the per-board charge selection `slots` runs after reading a
// board, and the operator's charging switch (`slots --no-charge`).
// Run with `npm test` (builds to dist/ first, then node --test).
const test = require("node:test");
const assert = require("node:assert/strict");

const { selectChargingSlot } = require("../../dist/S1TTXX/utils/charge_schedule");
const {
  PB_STATUS_CHARGING,
  PB_STATUS_PLUGGED_IN,
} = require("../../dist/utils/constants");

/** A docked pack at `powerLevel` % reporting `status`. */
function pack(slotIndex, status, powerLevel, currentCharge = 12000) {
  return {
    slotIndex,
    isPowerbankPresent: true,
    powerBankInfo: { status, currentCharge, totalCharge: 14125, cutoffCharge: 10625 },
    powerLevel,
    needsCharging: powerLevel < 100,
  };
}

const empty = (slotIndex) => ({
  slotIndex,
  isPowerbankPresent: false,
  powerBankInfo: null,
  powerLevel: 0,
  needsCharging: false,
});

const board = () => [
  pack(0, PB_STATUS_PLUGGED_IN, 80),
  pack(1, PB_STATUS_PLUGGED_IN, 20),
  empty(2),
  pack(3, PB_STATUS_PLUGGED_IN, 55),
  empty(4),
  empty(5),
];

test("charging on (default): arms the emptiest plugged-in pack", () => {
  assert.equal(selectChargingSlot(board()), 1);
  assert.equal(selectChargingSlot(board(), { chargingEnabled: true }), 1);
});

test("charging on: a pack already charging keeps the board's slot", () => {
  const slots = board();
  slots[3] = pack(3, PB_STATUS_CHARGING, 55);
  assert.equal(selectChargingSlot(slots, { chargingEnabled: true }), 3);
});

test("charging off: no slot is armed, even one already charging", () => {
  const slots = board();
  slots[3] = pack(3, PB_STATUS_CHARGING, 55);
  assert.equal(selectChargingSlot(slots, { chargingEnabled: false }), -1);
});

test("charging off on an empty board arms nothing", () => {
  const slots = [0, 1, 2, 3, 4, 5].map(empty);
  assert.equal(selectChargingSlot(slots, { chargingEnabled: false }), -1);
  assert.equal(selectChargingSlot(slots, { chargingEnabled: true }), -1);
});
