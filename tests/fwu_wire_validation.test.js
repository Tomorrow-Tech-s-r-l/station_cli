/**
 * Host-side guards on FWU requests, pinned for both device classes.
 *
 * These throw before anything reaches the wire, and each one prevents a
 * specific way of soft-bricking a device: an oversized chunk the bootloader
 * would reject mid-stream, an odd-length non-final chunk that makes the next
 * write collide on an already-programmed half-word (B-17 / V-29), and a slot
 * index outside the board. The messages are what an operator sees, so they are
 * pinned verbatim.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { FwuDataCommand, FWU_MAX_CHUNK } = require("../dist/S1TTXX/cli/commands/fwu_data");
const { PbFwuDataCommand } = require("../dist/S1TTXX/cli/commands/pb_fwu_data");
const { PbFwuBeginCommand } = require("../dist/S1TTXX/cli/commands/pb_fwu_begin");
const { PbFwuEndCommand } = require("../dist/S1TTXX/cli/commands/pb_fwu_end");
const { PbFwuAbortCommand } = require("../dist/S1TTXX/cli/commands/pb_fwu_abort");
const { PbFwuExitCommand } = require("../dist/S1TTXX/cli/commands/pb_fwu_exit");
const { PbFwuHelloCommand } = require("../dist/S1TTXX/cli/commands/pb_fwu_hello");
const { PbEnterBootCommand } = require("../dist/S1TTXX/cli/commands/pb_enter_boot");

/** A service that fails the test if anything reaches the wire. */
const noWire = {
  sendMessage: async () => {
    throw new Error("request reached the wire despite failing validation");
  },
};

test("the chunk ceiling is 32 bytes", () => {
  assert.equal(FWU_MAX_CHUNK, 32);
});

test("station DATA rejects an oversized chunk", async () => {
  await assert.rejects(
    new FwuDataCommand(noWire).execute(0, { offset: 0, bytes: Buffer.alloc(33), isFinal: true }),
    { message: "FWU_DATA chunk too large: 33 > 32 (FWU_MAX_CHUNK)" }
  );
});

test("station DATA rejects an odd-length non-final chunk", async () => {
  await assert.rejects(
    new FwuDataCommand(noWire).execute(0, { offset: 0, bytes: Buffer.alloc(7) }),
    {
      message:
        "FWU_DATA non-final chunk must be even-length (got 7); set isFinal=true on the last chunk only",
    }
  );
});

test("powerbank DATA rejects an oversized chunk", async () => {
  await assert.rejects(
    new PbFwuDataCommand(noWire).execute(0, 1, { offset: 0, bytes: Buffer.alloc(33), isFinal: true }),
    { message: "PB_FWU_DATA chunk too large: 33 > 32 (FWU_MAX_CHUNK)" }
  );
});

test("powerbank DATA rejects an odd-length non-final chunk", async () => {
  await assert.rejects(
    new PbFwuDataCommand(noWire).execute(0, 1, { offset: 0, bytes: Buffer.alloc(7) }),
    {
      message:
        "PB_FWU_DATA non-final chunk must be even-length (got 7); set isFinal=true on the last chunk only",
    }
  );
});

test("every powerbank command rejects an out-of-range slot before touching the wire", async () => {
  const bad = 99;
  const expected = { message: /^Slot index must be between 0 and \d+$/ };
  await assert.rejects(new PbEnterBootCommand(noWire).execute(0, bad), expected);
  await assert.rejects(new PbFwuHelloCommand(noWire).execute(0, bad), expected);
  await assert.rejects(
    new PbFwuBeginCommand(noWire).execute(0, bad, { imgSize: 1, imgCrc32: 0, version: 0 }),
    expected
  );
  await assert.rejects(
    new PbFwuDataCommand(noWire).execute(0, bad, { offset: 0, bytes: Buffer.alloc(2) }),
    expected
  );
  await assert.rejects(new PbFwuEndCommand(noWire).execute(0, bad), expected);
  await assert.rejects(new PbFwuAbortCommand(noWire).execute(0, bad), expected);
  await assert.rejects(new PbFwuExitCommand(noWire).execute(0, bad), expected);
  await assert.rejects(new PbFwuExitCommand(noWire).execute(0, -1), expected);
});

test("the slot check runs before the chunk checks", async () => {
  // Order matters for the operator: an impossible slot is the more
  // fundamental error and should be the one reported.
  await assert.rejects(
    new PbFwuDataCommand(noWire).execute(0, 99, { offset: 0, bytes: Buffer.alloc(33) }),
    { message: /^Slot index must be between/ }
  );
});
