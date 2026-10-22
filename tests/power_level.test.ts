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
import { calculatePowerLevel, isLowVoltage } from "../src/S1TTXX/utils/power_level";
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
    calculatePowerLevel(600, 500, 10625)
  );
  check("inverted-anchors", v === 0, `inverted pair must yield 0, got ${v}`);
  check("inverted-anchors", v >= 0, "must never go negative");
}

// --- Overshoot must be clamped AND reported ---
{
  const [v, msgs] = withCapture(() =>
    calculatePowerLevel(15000, 14125, 10625)
  );
  check("clamp-overshoot", v === 100, `overshoot must clamp to 100, got ${v}`);
  check("clamp-overshoot", msgs.length === 1, "the pre-clamp value must be logged, not hidden");
  check("clamp-overshoot", msgs[0].includes("raw=125"), `expected raw=125 in log, got: ${msgs[0]}`);
}

// --- The calibrated span is the denominator ---
{
  const v = calculatePowerLevel(12000, 14125, 10625);
  const expected = Math.trunc((100 * (12000 - 10625)) / (14125 - 10625)); // 39
  check("span", v === expected,
    `must be measuredCap/prevCap: expected ${expected}, got ${v}`);
  check("span", v === 39, "sanity: 1375/3500 truncates to 39");
  check("span", calculatePowerLevel(13000, 14125, 10625) === 67,
    "a mid-charge pack must read 67 (a voltage at offset 23 once made it 15)");
  check("span", calculatePowerLevel(14125, 14125, 10625) === 100, "a full pack must read 100");
}

// --- Zero denominator ---
{
  const v = calculatePowerLevel(10625, 10625, 10625);
  check("zero-denominator", v === 0, `zero span must give 0, got ${v}`);
  check("zero-denominator", Number.isFinite(v), "must never be NaN or Infinity");
}

// --- String / undefined inputs (real call sites pass parsed JSON) ---
{
  const v = calculatePowerLevel("12000", "14125", "10625");
  check("coerced-inputs", v === 39, `string inputs must coerce, got ${v}`);
  const u = calculatePowerLevel(undefined, undefined, undefined);
  check("coerced-inputs", u === 0, `undefined inputs must be safe, got ${u}`);
}

// --- Pack voltage below the threshold flags low voltage in any state ---
{
  check("low-voltage", isLowVoltage(PB_STATUS_DISCHARGING, 11000), "11000 mV must be low");
  check("low-voltage", !isLowVoltage(PB_STATUS_CHARGING, 15800), "15800 mV must not be low");
  check("low-voltage", !isLowVoltage(PB_STATUS_DISCHARGING, 0), "0 mV means unknown, not low");
}

console.error = realError;
console.log(`${checks} checks passed\n`);
