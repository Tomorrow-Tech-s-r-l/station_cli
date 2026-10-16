// Unit tests for station model selection on the command line.
// Run with `npm test` (builds to dist/ first, then node --test).
const test = require("node:test");
const assert = require("node:assert/strict");

const { extractModelFromArgv } = require("../../dist/utils/model_cli");

const argv = (...args) => ["node", "cli.js", ...args];

test("defaults to S1TT30 and leaves argv untouched", () => {
  const a = argv("status", "-i", "3");
  assert.equal(extractModelFromArgv(a), "S1TT30");
  assert.deepEqual(a, argv("status", "-i", "3"));
});

test("positional first-argument token is still accepted and stripped", () => {
  const a = argv("S1TT6", "slots");
  assert.equal(extractModelFromArgv(a), "S1TT6");
  assert.deepEqual(a, argv("slots"));
});

test("-m, --model and --model= are accepted anywhere and stripped", () => {
  for (const flag of [["-m", "S1TT6"], ["--model", "S1TT6"], ["--model=S1TT6"]]) {
    const a = argv("unlock", ...flag, "-i", "2");
    assert.equal(extractModelFromArgv(a), "S1TT6");
    assert.deepEqual(a, argv("unlock", "-i", "2"));
  }
});

test("matching positional and flag are fine; conflicting ones are rejected", () => {
  assert.equal(extractModelFromArgv(argv("S1TT6", "slots", "-m", "S1TT6")), "S1TT6");
  assert.throws(() => extractModelFromArgv(argv("S1TT30", "slots", "-m", "S1TT6")), /Conflicting/);
});

test("unknown or missing model values are rejected", () => {
  assert.throws(() => extractModelFromArgv(argv("slots", "--model", "S1TT9")), /Unknown station model/);
  assert.throws(() => extractModelFromArgv(argv("slots", "-m")), /requires a model/);
});

test("arguments after -- are not inspected", () => {
  const a = argv("convert", "--", "-m", "S1TT6");
  assert.equal(extractModelFromArgv(a), "S1TT30");
  assert.deepEqual(a, argv("convert", "--", "-m", "S1TT6"));
});
