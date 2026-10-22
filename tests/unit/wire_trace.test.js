// Unit tests for parsing the station's pogo-link log (HOST_CMD_PB_WIRE_TRACE).
// Layout v3: S1TTXX-firmware inc/pb_wire_log.h. Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseWireRecord } = require("../../dist/S1TTXX/services/wire_trace");

const tx = (b) => Buffer.from([0xea, b, b, b]);
const exchange = (cmd, flags, t, recorded, seen, attempts) =>
  Buffer.concat([Buffer.from([cmd, flags, t.length]), t, Buffer.from([recorded, seen]), ...attempts]);
const attempt = (outcome, drained, rx) =>
  Buffer.concat([Buffer.from([outcome, drained & 0xff, drained >> 8, rx.length]), rx]);

test("STATUS with the INFO_EXT -> INFO fallback keeps both exchanges", () => {
  const rec = Buffer.concat([
    Buffer.from([3, 0, 2, 2]),
    exchange(0x08, 0, tx(1), 1, 1, [attempt(0, 0, Buffer.from([0xea, 7]))]),
    exchange(0x01, 0, tx(2), 1, 1, [attempt(0, 300, Buffer.from([0xea, 8, 8]))]),
  ]);
  const r = parseWireRecord(rec);
  assert.equal(r.slot, 0);
  assert.equal(r.seen, 2);
  assert.equal(r.incomplete, false);
  assert.deepEqual(r.exchanges.map((e) => e.pbCommand), [0x08, 0x01]);
  assert.deepEqual([...r.exchanges[1].tx], [...tx(2)]);
  assert.deepEqual(r.exchanges[1].attempts[0], { outcome: 0, truncated: false, drained: 300, rx: Buffer.from([0xea, 8, 8]) });
});

test("retries, cut replies and entries that did not fit are reported", () => {
  const rec = Buffer.concat([
    Buffer.from([3, 1, 1, 2]),
    exchange(0x08, 1, tx(1), 2, 3, [attempt(1, 0, Buffer.alloc(0)), attempt(0x80 | 2, 0, Buffer.from([9, 9]))]),
  ]);
  const r = parseWireRecord(rec);
  assert.equal(r.seen, 2);
  assert.equal(r.exchanges.length, 1);
  const ex = r.exchanges[0];
  assert.equal(ex.txCut, true);
  assert.equal(ex.seen, 3);
  assert.equal(ex.attempts.length, 2);
  assert.equal(ex.attempts[1].outcome, 2);
  assert.equal(ex.attempts[1].truncated, true);
});

test("a log cut short by a missing page keeps what arrived and flags it", () => {
  const full = Buffer.concat([Buffer.from([3, 0, 1, 1]), exchange(0x01, 0, tx(1), 1, 1, [attempt(3, 0, Buffer.from([1, 2, 3, 4, 5]))])]);
  const r = parseWireRecord(full.subarray(0, full.length - 2));
  assert.equal(r.exchanges[0].attempts[0].rx.length, 3);
  assert.equal(r.incomplete, true);
});

test("empty, headerless or other-version logs are not parsed", () => {
  assert.equal(parseWireRecord(Buffer.alloc(0)), null);
  assert.equal(parseWireRecord(Buffer.from([3, 0])), null);
  assert.equal(parseWireRecord(Buffer.from([2, 0, 8, 0, 0, 0])), null);
});
