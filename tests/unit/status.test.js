// Unit tests for the CMD_STATUS decode: bytes 23..24 are the pack voltage the
// board appends from STATUS_EXT (S1TTXX >= v3.0.3), absent on older boards.
// Run with `npm test` (builds to dist/ first, then node --test).
const test = require("node:test");
const assert = require("node:assert/strict");

const { StatusCommand } = require("../../dist/S1TTXX/cli/commands/status");
const { CMD_STATUS_CODE } = require("../../dist/utils/constants");

/** A stub SerialService answering CMD_STATUS with `payload`. */
function statusOf(payload) {
  const service = {
    async sendMessage() {
      return Buffer.concat([Buffer.from([0, CMD_STATUS_CODE, 0]), payload]);
    },
  };
  return new StatusCommand(service)
    .execute(0, 0)
    .then((r) => JSON.parse(r.data.toString()));
}

function payload(length) {
  const p = Buffer.alloc(length);
  p.write("PB00000001", 0, "utf8");
  p.writeUInt16LE(14125, 14);
  p.writeUInt16LE(13000, 16);
  p.writeUInt16LE(10625, 18);
  p.writeUInt8(3, 22); // CHARGING
  if (length >= 25) p.writeUInt16LE(15800, 23);
  return p;
}

test("a 23-byte reply (board <= v3.0.1) reports no pack voltage", async () => {
  const info = await statusOf(payload(23));
  assert.equal(info.packVoltageMv, 0);
  assert.equal(info.currentCharge, 13000);
});

test("a 25-byte reply reports the pack voltage at offset 23", async () => {
  const info = await statusOf(payload(25));
  assert.equal(info.packVoltageMv, 15800);
  assert.equal("avgCapacity" in info, false);
});
