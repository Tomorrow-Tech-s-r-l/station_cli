// Unit tests for the powerbank charge-parameter guards.
// Run with `npm test` (builds to dist/ first, then node --test).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  checkBatteryInfo,
  checkInitialBatteryParams,
  isBatteryInfoValid,
  defaultBatteryParams,
  DEFAULT_TOTAL_CHARGE_MAH,
  DEFAULT_CURRENT_CHARGE_MAH,
  DEFAULT_CUTOFF_CHARGE_MAH,
} = require("../../dist/S1TTXX/utils/battery_info");

const {
  electChargingSlot,
} = require("../../dist/S1TTXX/utils/charge_election");

const { calculatePowerLevel } = require("../../dist/S1TTXX/utils/power_level");

const PB_STATUS_IDLE = 1;
const PB_STATUS_PLUGGED_IN = 2;
const PB_STATUS_CHARGING = 3;
const PB_STATUS_CUTOFF = 5;

test("factory defaults are self-consistent", () => {
  assert.deepEqual(checkBatteryInfo(defaultBatteryParams()), []);
  assert.deepEqual(checkInitialBatteryParams(defaultBatteryParams()), []);
  assert.equal(isBatteryInfoValid(defaultBatteryParams()), true);
});

test("cutoff >= total is caught (the field case: pack pinned at 0%)", () => {
  const bad = { totalCharge: 10000, currentCharge: 9000, cutoffCharge: 10625 };
  assert.ok(checkBatteryInfo(bad).includes("cutoff_ge_total"));
  // Confirms why it matters: the level can never read anything but 0.
  assert.equal(
    calculatePowerLevel(bad.currentCharge, bad.totalCharge, bad.cutoffCharge),
    0
  );
});

test("zeroed and truncated nameplates are caught", () => {
  assert.ok(
    checkBatteryInfo({
      totalCharge: 0,
      currentCharge: 0,
      cutoffCharge: 0,
    }).includes("total_implausible")
  );
  assert.ok(
    checkBatteryInfo({
      totalCharge: 137,
      currentCharge: 100,
      cutoffCharge: 50,
    }).includes("total_implausible")
  );
});

test("a pack that believes it is over-full is caught", () => {
  assert.ok(
    checkBatteryInfo({
      totalCharge: 13925,
      currentCharge: 60000,
      cutoffCharge: 10625,
    }).includes("current_gt_total")
  );
});

test("missing or unparseable fields do not throw", () => {
  assert.ok(checkBatteryInfo(undefined).length > 0);
  assert.ok(checkBatteryInfo(null).length > 0);
  assert.ok(checkBatteryInfo({}).length > 0);
});

test("a discharged pack below cutoff is valid at runtime, invalid to write", () => {
  const discharged = {
    totalCharge: DEFAULT_TOTAL_CHARGE_MAH,
    currentCharge: DEFAULT_CUTOFF_CHARGE_MAH - 500,
    cutoffCharge: DEFAULT_CUTOFF_CHARGE_MAH,
  };
  // Legitimate for a deeply discharged pack that is still reporting.
  assert.deepEqual(checkBatteryInfo(discharged), []);
  // Nonsense as a freshly written nameplate.
  assert.ok(checkInitialBatteryParams(discharged).includes("current_lt_cutoff"));
});

const slot = (overrides) => ({
  slotIndex: 0,
  isPowerbankPresent: true,
  status: PB_STATUS_PLUGGED_IN,
  powerLevel: 50,
  batteryInfoValid: true,
  batteryInfoRepaired: false,
  ...overrides,
});

test("an already-charging pack keeps the slot", () => {
  const board = [
    slot({ slotIndex: 0, status: PB_STATUS_PLUGGED_IN, powerLevel: 5 }),
    slot({ slotIndex: 1, status: PB_STATUS_CHARGING, powerLevel: 90 }),
  ];
  assert.equal(electChargingSlot(board), 1);
});

test("the emptiest plugged-in pack wins, by level not raw mAh", () => {
  // The 5000 mAh pack at 100% holds fewer mAh than the 13925 mAh pack at 40%,
  // which is what used to win the old raw-mAh comparison.
  const board = [
    slot({ slotIndex: 0, powerLevel: 100 }),
    slot({ slotIndex: 1, powerLevel: 40 }),
  ];
  assert.equal(electChargingSlot(board), 1);
});

test("a just-repaired pack is charged despite a stale IDLE status", () => {
  // After the rewrite its parameters are sound again, but the status byte it
  // reported was computed from the old ones. Excluding it here is exactly the
  // bug being fixed.
  const board = [
    slot({
      slotIndex: 1,
      status: PB_STATUS_IDLE,
      powerLevel: 30,
      batteryInfoValid: true,
      batteryInfoRepaired: true,
    }),
  ];
  assert.equal(electChargingSlot(board), 1);
});

test("a just-repaired pack reporting CUTOFF is also charged", () => {
  const board = [
    slot({
      slotIndex: 3,
      status: PB_STATUS_CUTOFF,
      powerLevel: 30,
      batteryInfoValid: true,
      batteryInfoRepaired: true,
    }),
  ];
  assert.equal(electChargingSlot(board), 3);
});

test("a just-repaired pack still competes on level, it is not given priority", () => {
  const board = [
    slot({ slotIndex: 0, powerLevel: 5 }),
    slot({
      slotIndex: 1,
      status: PB_STATUS_IDLE,
      powerLevel: 30,
      batteryInfoValid: true,
      batteryInfoRepaired: true,
    }),
  ];
  assert.equal(electChargingSlot(board), 0);
});

test("a pack whose repair did not stick never starves a healthy one", () => {
  const board = [
    slot({
      slotIndex: 0,
      status: PB_STATUS_IDLE,
      powerLevel: 0,
      batteryInfoValid: false,
      batteryInfoRepaired: true,
    }),
    slot({ slotIndex: 1, powerLevel: 99 }),
  ];
  assert.equal(electChargingSlot(board), 1);
});

test("a pack that refused the repair never starves a healthy one", () => {
  const board = [
    slot({
      slotIndex: 0,
      status: PB_STATUS_IDLE,
      powerLevel: 0,
      batteryInfoValid: false,
      batteryInfoRepaired: false,
    }),
    slot({ slotIndex: 1, powerLevel: 99 }),
  ];
  assert.equal(electChargingSlot(board), 1);
});

test("an unrepairable pack still charges when it is alone on the board", () => {
  const board = [
    slot({
      slotIndex: 2,
      status: PB_STATUS_IDLE,
      powerLevel: 0,
      batteryInfoValid: false,
      batteryInfoRepaired: false,
    }),
    slot({ slotIndex: 3, isPowerbankPresent: false, status: undefined }),
  ];
  assert.equal(electChargingSlot(board), 2);
});

test("a slot whose status read failed is never elected", () => {
  const board = [
    slot({ slotIndex: 0, status: undefined, powerLevel: 0 }),
  ];
  assert.equal(electChargingSlot(board), -1);
});

test("a healthy IDLE pack is still left alone", () => {
  const board = [slot({ slotIndex: 0, status: PB_STATUS_IDLE, powerLevel: 100 })];
  assert.equal(electChargingSlot(board), -1);
});

test("an empty board charges nothing", () => {
  const board = [
    slot({ slotIndex: 0, isPowerbankPresent: false, status: undefined }),
  ];
  assert.equal(electChargingSlot(board), -1);
});

test("ties resolve to the lowest slot index, so polls are stable", () => {
  const board = [
    slot({ slotIndex: 4, powerLevel: 30 }),
    slot({ slotIndex: 1, powerLevel: 30 }),
    slot({ slotIndex: 2, powerLevel: 30 }),
  ];
  assert.equal(electChargingSlot(board), 1);
  assert.equal(electChargingSlot([...board].reverse()), 1);
});

test("defaults match the initialize-powerbank documented values", () => {
  assert.equal(DEFAULT_TOTAL_CHARGE_MAH, 13925);
  assert.equal(DEFAULT_CURRENT_CHARGE_MAH, 11625);
  assert.equal(DEFAULT_CUTOFF_CHARGE_MAH, 10625);
});
