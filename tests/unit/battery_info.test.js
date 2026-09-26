// Unit tests for the powerbank charge-parameter check.
// Run with `npm test` (builds to dist/ first, then node --test).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isBatteryInfoValid,
  validateBatteryParams,
  defaultBatteryParams,
  DEFAULT_CUTOFF_CHARGE_MAH,
  DEFAULT_TOTAL_CHARGE_MAH,
  DEFAULT_CURRENT_CHARGE_MAH,
  DEFAULT_CHARGE_PERCENT,
  PACK_USABLE_CAPACITY_MAH,
  CHARGE_OVERSHOOT_TOLERANCE_MAH,
  MIN_CHARGE_SPAN_MAH,
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

test("a full pack sitting on total == current passes", () => {
  // The pack anchors its own capacity to the gauge when a charge cycle
  // completes (flashData.totalCap = LTC2943_Status.acr_mAh), so this is where
  // a healthy full pack parks — not an error state.
  const full = {
    totalCharge: DEFAULT_TOTAL_CHARGE_MAH,
    currentCharge: DEFAULT_TOTAL_CHARGE_MAH,
    cutoffCharge: DEFAULT_CUTOFF_CHARGE_MAH,
  };
  assert.equal(isBatteryInfoValid(full), true);
});

test("gauge wobble around the full anchor is tolerated, gross overshoot is not", () => {
  const at = (overshoot) =>
    isBatteryInfoValid({
      totalCharge: DEFAULT_TOTAL_CHARGE_MAH,
      currentCharge: DEFAULT_TOTAL_CHARGE_MAH + overshoot,
      cutoffCharge: DEFAULT_CUTOFF_CHARGE_MAH,
    });

  // The reported field case: current exactly one count above total.
  assert.equal(at(1), true);
  assert.equal(at(CHARGE_OVERSHOOT_TOLERANCE_MAH), true);
  assert.equal(at(CHARGE_OVERSHOOT_TOLERANCE_MAH + 1), false);
});

test("a usable window narrower than the firmware minimum fails", () => {
  // The pack itself rejects a CMD_SET_BINFO this narrow and repairs such a
  // pair at boot, so a pack reporting one has a nameplate worth rewriting.
  assert.equal(
    isBatteryInfoValid({
      totalCharge: 14125,
      currentCharge: 14000,
      cutoffCharge: 14125 - (MIN_CHARGE_SPAN_MAH - 1),
    }),
    false
  );
  assert.equal(
    isBatteryInfoValid({
      totalCharge: 14125,
      currentCharge: 14000,
      cutoffCharge: 14125 - MIN_CHARGE_SPAN_MAH,
    }),
    true
  );
});

test("validateBatteryParams passes the factory defaults", () => {
  assert.equal(validateBatteryParams(defaultBatteryParams()), null);
});

test("validateBatteryParams refuses the triple that strands a pack at 0%", () => {
  // Written with success:true by the CLI to a fw 3.0.2 pack on the bench:
  // cutoff above total, which empties the usable window permanently.
  const refusal = validateBatteryParams({
    totalCharge: 10000,
    currentCharge: 9000,
    cutoffCharge: 10625,
  });
  assert.match(String(refusal), /cutoff charge 10625 .* total charge 10000/);
});

test("validateBatteryParams refuses an over-full write", () => {
  // No tolerance here, unlike the read-side check: there is never a reason to
  // ask a pack to believe it holds more than its own capacity.
  assert.match(
    String(
      validateBatteryParams({
        totalCharge: 14125,
        currentCharge: 14126,
        cutoffCharge: 10625,
      })
    ),
    /current charge 14126 .* total charge 14125/
  );
});

test("validateBatteryParams refuses a zeroed or out-of-range field", () => {
  assert.match(
    String(
      validateBatteryParams({
        totalCharge: 0,
        currentCharge: 0,
        cutoffCharge: 0,
      })
    ),
    /total charge 0 mAh is below/
  );
  assert.match(
    String(
      validateBatteryParams({
        totalCharge: 70000,
        currentCharge: 11675,
        cutoffCharge: 10625,
      })
    ),
    /between 0 and 65535/
  );
  assert.match(
    String(validateBatteryParams({ totalCharge: 14125, cutoffCharge: 10625 })),
    /current charge must be a whole number/
  );
  assert.match(
    String(
      validateBatteryParams({
        totalCharge: 14125.5,
        currentCharge: 11675,
        cutoffCharge: 10625,
      })
    ),
    /total charge must be a whole number/
  );
});

test("validateBatteryParams refuses a window narrower than the firmware minimum", () => {
  assert.match(
    String(
      validateBatteryParams({
        totalCharge: 14125,
        currentCharge: 14100,
        cutoffCharge: 14125 - (MIN_CHARGE_SPAN_MAH - 1),
      })
    ),
    /usable window/
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
