// Unit tests for parsing the station's pogo-link log (HOST_CMD_PB_WIRE_TRACE).
// Layout v2: S1TTXX-firmware inc/pb_wire_log.h. Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseWireRecord } = require("../../dist/S1TTXX/services/wire_trace");

const tx = Buffer.from([0xea, 1, 2, 3]);
const header = (slot, cmd, recorded, seen) => Buffer.from([2, slot, cmd, recorded, seen, tx.length]);
const attempt = (outcome, drained, rx) =>
  Buffer.concat([Buffer.from([outcome, drained & 0xff, drained >> 8, rx.length]), rx]);

test("a full record parses into the request and each attempt", () => {
  const rec = Buffer.concat([header(2, 0x08, 2, 2), tx, attempt(1, 300, Buffer.alloc(0)), attempt(0, 0, Buffer.from([0xea, 9, 9]))]);
  const r = parseWireRecord(rec);
  assert.equal(r.slot, 2);
  assert.equal(r.pbCommand, 0x08);
  assert.deepEqual([...r.tx], [...tx]);
  assert.equal(r.seen, 2);
  assert.equal(r.incomplete, false);
  assert.deepEqual(r.attempts[0], { outcome: 1, drained: 300, rx: Buffer.alloc(0), truncated: false });
  assert.deepEqual([...r.attempts[1].rx], [0xea, 9, 9]);
});

test("reply bytes cut to fit the station log, and attempts that did not fit, are reported", () => {
  const rec = Buffer.concat([header(0, 0x01, 1, 3), tx, attempt(0x80 | 2, 0, Buffer.from([7, 7]))]);
  const r = parseWireRecord(rec);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].outcome, 2);
  assert.equal(r.attempts[0].truncated, true);
  assert.equal(r.seen, 3);
  assert.equal(r.incomplete, false);
});

test("a record cut short by a missing page keeps what arrived and flags it", () => {
  const full = Buffer.concat([header(0, 0x01, 1, 1), tx, attempt(3, 0, Buffer.from([1, 2, 3, 4, 5]))]);
  const r = parseWireRecord(full.subarray(0, full.length - 2));
  assert.equal(r.attempts[0].rx.length, 3);
  assert.equal(r.incomplete, true);
});

test("empty, headerless or unknown-version records are not parsed", () => {
  assert.equal(parseWireRecord(Buffer.alloc(0)), null);
  assert.equal(parseWireRecord(Buffer.from([2, 0, 1])), null);
  assert.equal(parseWireRecord(Buffer.from([1, 0, 8, 0, 0, 0])), null);
});
