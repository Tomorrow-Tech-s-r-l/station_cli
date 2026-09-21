// Unit tests for the powerbank charge-parameter check.
// Run with `npm test` (builds to dist/ first, then node --test).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isBatteryInfoValid,
  defaultBatteryParams,
  DEFAULT_CUTOFF_CHARGE_MAH,
  DEFAULT_TOTAL_CHARGE_MAH,
  DEFAULT_CURRENT_CHARGE_MAH,
  DEFAULT_CHARGE_PERCENT,
  PACK_USABLE_CAPACITY_MAH,
} = require("../../dist/S1TTXX/utils/battery_info");

const { calculatePowerLevel } = require("../../dist/S1TTXX/utils/power_level");

test("the factory defaults pass", () => {
  assert.equal(isBatteryInfoValid(defaultBatteryParams()), true);
  assert.deepEqual(defaultBatteryParams(), {
    totalCharge: 14125,
    currentCharge: 11675,
    cutoffCharge: 10625,
  });
});

test("the defaults describe a 4S 3500 mAh pack at 30%", () => {
  // total and current are derived, so this pins the derivation rather than
  // three magic numbers: the usable window is the pack's capacity, and the
  // default charge sits DEFAULT_CHARGE_PERCENT into it.
  assert.equal(PACK_USABLE_CAPACITY_MAH, 3500);
  assert.equal(DEFAULT_CHARGE_PERCENT, 30);
  assert.equal(
    DEFAULT_TOTAL_CHARGE_MAH - DEFAULT_CUTOFF_CHARGE_MAH,
    PACK_USABLE_CAPACITY_MAH
  );
  assert.equal(
    calculatePowerLevel(
      DEFAULT_CURRENT_CHARGE_MAH,
      DEFAULT_TOTAL_CHARGE_MAH,
      DEFAULT_CUTOFF_CHARGE_MAH
    ),
    DEFAULT_CHARGE_PERCENT
  );
});

test("cutoff >= total fails (the field case: pack pinned at 0%)", () => {
  const bad = { totalCharge: 10000, currentCharge: 9000, cutoffCharge: 10625 };
  assert.equal(isBatteryInfoValid(bad), false);
  // Confirms why it matters: the level can never read anything but 0.
  assert.equal(
    calculatePowerLevel(bad.currentCharge, bad.totalCharge, bad.cutoffCharge),
    0
  );
});

test("zeroed and truncated nameplates fail", () => {
  assert.equal(
    isBatteryInfoValid({ totalCharge: 0, currentCharge: 0, cutoffCharge: 0 }),
    false
  );
  assert.equal(
    isBatteryInfoValid({
      totalCharge: 137,
      currentCharge: 100,
      cutoffCharge: 50,
    }),
    false
  );
});

test("a pack that believes it is over-full fails", () => {
  assert.equal(
    isBatteryInfoValid({
      totalCharge: 13925,
      currentCharge: 60000,
      cutoffCharge: 10625,
    }),
    false
  );
});

test("a deeply discharged pack below its cutoff still passes", () => {
  assert.equal(
    isBatteryInfoValid({
      totalCharge: DEFAULT_TOTAL_CHARGE_MAH,
      currentCharge: DEFAULT_CUTOFF_CHARGE_MAH - 500,
      cutoffCharge: DEFAULT_CUTOFF_CHARGE_MAH,
    }),
    true
  );
});

test("missing or unparseable fields fail instead of throwing", () => {
  assert.equal(isBatteryInfoValid(undefined), false);
  assert.equal(isBatteryInfoValid(null), false);
  assert.equal(isBatteryInfoValid({}), false);
});
