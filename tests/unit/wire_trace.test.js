// Unit tests for parsing the station's pogo-link log (HOST_CMD_PB_WIRE_TRACE).
// Layout: S1TTXX-firmware inc/pb_wire_log.h. Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseWireRecord } = require("../../dist/S1TTXX/services/wire_trace");

const tx = Buffer.from([0xea, 1, 2, 3]);
const attempt = (outcome, drained, rx) =>
  Buffer.concat([Buffer.from([outcome, drained & 0xff, drained >> 8, tx.length, rx.length]), tx, rx]);

test("a full record parses into its attempts", () => {
  const rec = Buffer.concat([
    Buffer.from([1, 2, 0x08, 2]),
    attempt(1, 300, Buffer.alloc(0)),
    attempt(0, 0, Buffer.from([0xea, 9, 9])),
  ]);
  const r = parseWireRecord(rec);
  assert.equal(r.version, 1);
  assert.equal(r.slot, 2);
  assert.equal(r.pbCommand, 0x08);
  assert.equal(r.attempts.length, 2);
  assert.deepEqual(r.attempts[0], { outcome: 1, drained: 300, tx, rx: Buffer.alloc(0), truncated: false });
  assert.deepEqual([...r.attempts[1].rx], [0xea, 9, 9]);
  assert.equal(r.attempts[1].truncated, false);
});

test("a record cut short by a missing page keeps what arrived and flags it", () => {
  const full = Buffer.concat([Buffer.from([1, 0, 0x01, 1]), attempt(3, 0, Buffer.from([1, 2, 3, 4, 5]))]);
  const r = parseWireRecord(full.subarray(0, full.length - 2));
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].rx.length, 3);
  assert.equal(r.attempts[0].truncated, true);
});

test("an empty or headerless record is reported as nothing recorded", () => {
  assert.equal(parseWireRecord(Buffer.alloc(0)), null);
  assert.equal(parseWireRecord(Buffer.from([1, 0])), null);
});
