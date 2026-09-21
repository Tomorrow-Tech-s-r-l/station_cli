/**
 * Host tests for calculatePowerLevel — the function that produces the battery
 * percentage reported for a docked powerbank.
 *
 * Deliberately no test framework: this is a pure function, so node:assert over
 * a table of cases is the whole requirement.
 *
 *   npx ts-node tests/power_level.test.ts
 */
import assert from "node:assert";
import { calculatePowerLevel } from "../src/S1TTXX/utils/power_level";
import { PB_STATUS_CHARGING, PB_STATUS_DISCHARGING } from "../src/utils/constants";

let checks = 0;
const check = (id: string, cond: boolean, msg: string) => {
  assert.ok(cond, `${id}: ${msg}`);
  checks++;
};

// Silence the intentional clamp warnings, and capture them so the cases below
// can assert an overshoot is reported rather than hidden.
let logged: string[] = [];
const realError = console.error;
console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
const withCapture = <T>(fn: () => T): [T, string[]] => {
  logged = [];
  const out = fn();
  return [out, logged];
};

console.log("\n=== station_cli power_level tests ===\n");

// --- Inverted anchor pair: cutoff above total, so the span is negative ---
{
  const [v] = withCapture(() =>
    calculatePowerLevel(600, 500, 10625, 3500, PB_STATUS_DISCHARGING)
  );
  check("inverted-anchors", v === 0, `inverted pair must yield 0, got ${v}`);
  check("inverted-anchors", v >= 0, "must never go negative");
}

// --- Overshoot must be clamped AND reported ---
{
  const [v, msgs] = withCapture(() =>
    calculatePowerLevel(15000, 14125, 10625, 3500, PB_STATUS_CHARGING)
  );
  check("clamp-overshoot", v === 100, `overshoot must clamp to 100, got ${v}`);
  check("clamp-overshoot", msgs.length === 1, "the pre-clamp value must be logged, not hidden");
  check("clamp-overshoot", msgs[0].includes("raw=125"), `expected raw=125 in log, got: ${msgs[0]}`);
}

// --- Firmware that does not report avgCapacity (sends 0) ---
{
  const withAvg = calculatePowerLevel(12000, 14125, 10625, 0, PB_STATUS_CHARGING);
  const expected = Math.trunc((100 * (12000 - 10625)) / (14125 - 10625)); // 39
  check("legacy-firmware", withAvg === expected,
    `avgCapacity=0 must reduce to measuredCap/prevCap: expected ${expected}, got ${withAvg}`);
  check("legacy-firmware", withAvg === 39, "sanity: 1375/3500 truncates to 39");
}

// --- Zero denominator ---
{
  const v = calculatePowerLevel(10625, 10625, 10625, 0, PB_STATUS_DISCHARGING);
  check("zero-denominator", v === 0, `zero span must give 0, got ${v}`);
  check("zero-denominator", Number.isFinite(v), "must never be NaN or Infinity");
}

// --- String / undefined inputs (real call sites pass parsed JSON) ---
{
  const v = calculatePowerLevel("12000", "14125", "10625", "3500", PB_STATUS_CHARGING);
  check("coerced-inputs", v === 39, `string inputs must coerce, got ${v}`);
  const u = calculatePowerLevel(undefined, undefined, undefined, undefined, undefined);
  check("coerced-inputs", u === 0, `undefined inputs must be safe, got ${u}`);
}

// --- The avgCapacity ceiling still applies while CHARGING ---
{
  const v = calculatePowerLevel(12000, 12000, 10625, 3500, PB_STATUS_CHARGING);
  // prevCap = 1375, avgCap = 3500 > prevCap, so socDenom = 3500 while CHARGING
  check("avgcap-ceiling", v === Math.trunc((100 * 1375) / 3500),
    `avgCap ceiling must apply while CHARGING, got ${v}`);
}

console.error = realError;
console.log(`${checks} checks passed\n`);
