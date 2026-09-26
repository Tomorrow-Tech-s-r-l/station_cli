/**
 * Golden tests for the firmware-update orchestrators.
 *
 * These pin the COMPLETE observable behaviour of a flash — every frame put on
 * the wire, in order, byte for byte, plus the result object the CLI prints —
 * across the success path and every failure path the fake device can model.
 *
 * They exist so that refactors are provably behaviour-preserving: the golden
 * files were generated from the code as it stood before the station and
 * powerbank orchestrators were unified, and the unified implementation must
 * reproduce them exactly. A diff here is a wire-protocol change, and a wire
 * protocol change is never an accident.
 *
 * Regenerate (only when a protocol change is intended):
 *   UPDATE_GOLDEN=1 npm run test:unit
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FakeBootloaderDevice } = require("./helpers/fake_bootloader");
const { runStationFirmwareUpdate } = require("../dist/S1TTXX/cli/commands/firmware_update");
const { runPbFirmwareUpdate } = require("../dist/S1TTXX/cli/commands/pb_firmware_update");

const GOLDEN_DIR = path.join(__dirname, "golden", "fwu");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

/** Deterministic image content, so transcripts are stable across runs. */
function makeImage(size) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

function writeImage(size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fwu-golden-"));
  const p = path.join(dir, "image.bin");
  fs.writeFileSync(p, makeImage(size));
  return p;
}

/** Drops the fields that legitimately vary per run. */
function normalise(result) {
  const copy = JSON.parse(JSON.stringify(result));
  delete copy.durationMs;
  copy.imagePath = path.basename(copy.imagePath);
  return copy;
}

const SCENARIOS = [
  { name: "success", faults: {} },
  { name: "success-odd-length", faults: {}, imageSize: 1001 },
  { name: "resync-after-lost-chunk", faults: { offsetMismatchAt: 5 } },
  { name: "data-rejected", faults: { failDataAt: 4 } },
  { name: "bogus-next-offset", faults: { bogusOffsetAt: 3 } },
  { name: "crc-mismatch", faults: { corruptCrc: true } },
  { name: "enter-refused", faults: { enterFails: true } },
  { name: "no-hello", faults: { noHello: true } },
  { name: "short-hello", faults: { shortHello: true } },
  { name: "image-too-large", faults: {}, slotSize: 512 },
  { name: "exit-not-acked", faults: { exitFails: true } },
  { name: "recovers-from-stuck-bootloader", faults: { startInBootloader: true } },
];

const KINDS = [
  {
    kind: "station",
    run: (dev, imagePath) =>
      runStationFirmwareUpdate(dev, {
        boardAddress: 2,
        imagePath,
        version: 0x00030100,
      }),
    device: (s) => new FakeBootloaderDevice({ kind: "station", boardAddress: 2, ...s }),
  },
  {
    kind: "powerbank",
    run: (dev, imagePath) =>
      runPbFirmwareUpdate(dev, {
        boardAddress: 2,
        slotInBoard: 4,
        imagePath,
        version: 0x00030004,
      }),
    device: (s) =>
      new FakeBootloaderDevice({ kind: "powerbank", boardAddress: 2, slotInBoard: 4, ...s }),
  },
];

for (const k of KINDS) {
  for (const sc of SCENARIOS) {
    test(`${k.kind}: ${sc.name}`, async () => {
      const device = k.device({
        faults: sc.faults,
        ...(sc.slotSize ? { slotSize: sc.slotSize } : {}),
      });
      const imagePath = writeImage(sc.imageSize ?? 1000);
      const result = await k.run(device, imagePath);

      const actual = { result: normalise(result), transcript: device.transcript };
      const file = path.join(GOLDEN_DIR, `${k.kind}-${sc.name}.json`);

      if (UPDATE || !fs.existsSync(file)) {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
        if (!UPDATE) {
          // A missing golden is written once and the test fails, so a new
          // scenario cannot silently pass on its first run.
          assert.fail(`golden file created: ${path.relative(process.cwd(), file)} — re-run to verify`);
        }
        return;
      }

      const expected = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(actual, expected);
    });
  }
}

test("the success path really lands a valid image on the device", async () => {
  // Guards the fake itself: if it accepted anything, the goldens would pin
  // nonsense. A successful run must leave the header stamped with the version.
  for (const k of KINDS) {
    const device = k.device({ faults: {} });
    const result = await k.run(device, writeImage(1000));
    assert.equal(result.success, true, `${k.kind} should succeed`);
    assert.notEqual(device.headerVersion, null, `${k.kind} header should be stamped`);
    assert.equal(device.mode, "app", `${k.kind} should be back in its application`);
  }
});

test("a failed run leaves the device without a valid header", async () => {
  for (const k of KINDS) {
    const device = k.device({ faults: { failDataAt: 4 } });
    const result = await k.run(device, writeImage(1000));
    assert.equal(result.success, false);
    assert.equal(device.headerVersion, null, `${k.kind}: header must stay erased after a failed flash`);
  }
});
