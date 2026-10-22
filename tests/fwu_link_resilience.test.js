/**
 * A flash over a link that loses frames.
 *
 * Field case: a P1TT2C pack behind an S1TTXX board, 3.0.2 → 3.1.0, failed
 * part-way through the image with "device stopped answering". That message is
 * the engine's wording for a transport exception — SerialService's 5 s
 * timeout, i.e. the board sent back no frame it could parse — and until now a
 * single such frame ended the attempt: the next attempt started over from
 * ENTER and offset 0, and one more lost frame failed the device.
 *
 * Both bootloaders already make a re-send of the same offset safe (a chunk
 * they already wrote is answered OFFSET_MISMATCH + next_expected_offset), so
 * the session now re-sends the chunk instead. These tests drive that path
 * against the fake bootloader's link faults.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FakeBootloaderDevice } = require("./helpers/fake_bootloader");
const { runPbFirmwareUpdate } = require("../dist/S1TTXX/cli/commands/pb_firmware_update");
const { runStationFirmwareUpdate } = require("../dist/S1TTXX/cli/commands/firmware_update");

const NO_WAIT = [0, 0, 0];

function image(size) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 13 + 5) & 0xff;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fwu-link-"));
  const p = path.join(dir, "image.bin");
  fs.writeFileSync(p, b);
  return { path: p, bytes: b };
}

function pack(faults) {
  return new FakeBootloaderDevice({ kind: "powerbank", boardAddress: 3, slotInBoard: 2, slotSize: 21504, faults });
}

const flashPack = (dev, img, extra = {}) =>
  runPbFirmwareUpdate(dev, {
    boardAddress: 3,
    slotInBoard: 2,
    imagePath: img.path,
    version: 0x00030101,
    dataResendBackoffMs: NO_WAIT,
    ...extra,
  });

/** Offsets of every DATA frame the device received, in order. */
function dataOffsets(dev) {
  return dev.transcript
    .filter((t) => t.cmd === "0x13")
    .map((t) => Buffer.from(t.data, "hex").readUInt32LE(1));
}

/**
 * The fake only stamps the header at END when every byte arrived in order and
 * the CRC32 of what it holds matches the image's, so a stamped header proves
 * the whole image landed intact.
 */
function assertFlashed(dev) {
  assert.equal(dev.headerVersion, 0x00030101);
  assert.equal(dev.mode, "app", "the pack rebooted into its new application");
}

test("a lost DATA reply: the same chunk is re-sent and the bootloader's resync carries on", async () => {
  const img = image(640);
  const dev = pack({ lostReplyAt: [3] });
  const r = await flashPack(dev, img);
  assert.equal(r.success, true, JSON.stringify(r.error));
  assertFlashed(dev);
  // Chunk 3 (offset 64) was written but its reply lost: re-sent once, answered
  // OFFSET_MISMATCH → 96, and the transfer went on from there.
  const offsets = dataOffsets(dev);
  assert.deepEqual(offsets.slice(0, 5), [0, 32, 64, 64, 96]);
  assert.equal(offsets.length, 21);
  assert.equal(r.retries, 2, "one re-send and one resync");
});

test("a lost DATA request: the chunk is re-sent until it lands", async () => {
  const img = image(640);
  const dev = pack({ lostRequestAt: [3, 4] });
  const r = await flashPack(dev, img);
  assert.equal(r.success, true, JSON.stringify(r.error));
  assertFlashed(dev);
  assert.deepEqual(dataOffsets(dev).slice(0, 6), [0, 32, 64, 64, 64, 96]);
});

test("a pogo link timeout on DATA is re-sent, and its garbage offset is never read (V-19 no longer trips)", async () => {
  // The board answers STATUS_TIMEOUT with stack bytes where
  // next_expected_offset goes (0xdeadbeef here). BaseCommand already retries
  // a link timeout twice, so it takes three in a row (frames 5-7) to reach
  // the session. Before, the V-19 guard read that value and aborted the flash.
  const img = image(640);
  const dev = pack({ linkTimeoutAt: [5, 6, 7] });
  const r = await flashPack(dev, img);
  assert.equal(r.success, true, JSON.stringify(r.error));
  assertFlashed(dev);
  assert.deepEqual(dataOffsets(dev).slice(3, 9), [96, 128, 128, 128, 128, 160]);
});

test("the station board path re-sends the same way", async () => {
  const img = image(640);
  const dev = new FakeBootloaderDevice({ kind: "station", boardAddress: 1, faults: { lostReplyAt: [7] } });
  const r = await runStationFirmwareUpdate(dev, {
    boardAddress: 1,
    imagePath: img.path,
    version: 0x00030201,
    dataResendBackoffMs: NO_WAIT,
  });
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.equal(dev.headerVersion, 0x00030201);
});

test("a device that stays silent fails the attempt after 3 re-sends, saying where", async () => {
  const img = image(640);
  const dev = pack({ silentFromData: 3 });
  await assert.rejects(flashPack(dev, img), (e) => {
    assert.match(e.message, /Request timeout/);
    assert.match(e.message, /at offset 64\/640, after 3 re-send\(s\) of that chunk/);
    return true;
  });
  assert.deepEqual(dataOffsets(dev), [0, 32, 64, 64, 64, 64]);
});

test("a pogo link that never recovers fails the chunk as before, after the re-sends", async () => {
  const img = image(640);
  // Every send is tried three times by BaseCommand: 4 sends × 3 = frames 3-14.
  const dev = pack({ linkTimeoutAt: Array.from({ length: 12 }, (_, i) => i + 3) });
  const r = await flashPack(dev, img);
  assert.equal(r.success, false);
  assert.equal(r.error.stage, "PB_FWU_DATA");
  assert.equal(r.error.code, 0x01);
  assert.match(r.error.message, /at offset 64\/640, after 3 re-send\(s\).*link timeout/);
  // Torn down: ABORT was sent.
  assert.equal(dev.transcript.at(-1).cmd, "0x15");
});

test("a link losing frames all along is given up after 20 re-sends in the session", async () => {
  const img = image(800); // 25 chunks
  const lost = Array.from({ length: 30 }, (_, i) => 2 * i + 1); // every other frame
  const dev = pack({ lostRequestAt: lost });
  await assert.rejects(flashPack(dev, img), /at offset 640\/800, after 0 re-send\(s\) of that chunk/);
});

test("a device that reset mid-transfer is reported as such, not re-sent to", async () => {
  const img = image(640);
  const dev = pack({ powerLossAt: 4 });
  // powerLossAt: the 4th DATA is never answered and the device comes back up
  // in its bootloader without the session. The re-send learns that.
  const r = await flashPack(dev, img);
  assert.equal(r.success, false);
  assert.equal(r.error.code, 0x13);
  assert.match(r.error.message, /lost its session/);
  assert.deepEqual(dataOffsets(dev), [0, 32, 64, 96, 96]);
});

test("host-side chunk guards are never treated as a lost frame", async () => {
  const img = image(640);
  // A bootloader advertising an odd chunk size makes the host refuse a
  // non-final odd chunk: that is a bug to surface, not a frame to re-send.
  const dev = new FakeBootloaderDevice({ kind: "powerbank", boardAddress: 3, slotInBoard: 2, slotSize: 21504, maxChunk: 31 });
  await assert.rejects(flashPack(dev, img), /non-final chunk must be even-length/);
  assert.equal(dataOffsets(dev).length, 0);
});
