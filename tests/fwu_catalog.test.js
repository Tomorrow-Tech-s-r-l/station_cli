/**
 * Catalog rules that do not need the network: which asset is an application
 * image, the safety floor configuration cannot remove, and cache pruning.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { assetRules, resolveCandidate, pruneCache } = require("../dist/S1TTXX/fwu/catalog");

test("default rules pick the application image for each device class", () => {
  assert.equal(assetRules("interface").accepts("S1TTXX-firmware-3.1.0.bin"), true);
  assert.equal(assetRules("powerbank").accepts("P1TT2C-firmware-3.0.4.bin"), true);
  assert.equal(assetRules("interface").accepts("S1TTXX-firmware-3.1.0.hex"), false);
  assert.equal(assetRules("interface").accepts("P1TT2C-firmware-3.0.4.bin"), false);
});

test("merged and bootloader images are refused by default", () => {
  assert.equal(assetRules("interface").accepts("S1TTXX-merged-3.1.0.bin"), false);
  assert.equal(assetRules("powerbank").accepts("P1TT2C-firmware-3.0.4-merged.bin"), false);
  assert.equal(assetRules("interface").accepts("S1TTXX-bootloader-3.1.0.bin"), false);
});

test("no configuration can re-admit a merged or bootloader image", () => {
  // Even a pattern that accepts everything cannot open the floor: a merged
  // image through the update path bricks the device.
  const permissive = { provider: "github", repo: "a/b", assetPattern: ".*" };
  assert.equal(assetRules("interface", permissive).accepts("anything-merged.bin"), false);
  assert.equal(assetRules("interface", permissive).accepts("x-BOOTLOADER-y.bin"), false);
  assert.equal(assetRules("interface", permissive).accepts("app.bin"), true);
});

test("a source can tighten the rules with its own reject pattern", () => {
  const src = { provider: "github", repo: "a/b", rejectPattern: "-rc\\d*\\.bin$" };
  assert.equal(assetRules("interface", src).accepts("S1TTXX-firmware-3.1.0-rc1.bin"), false);
  assert.equal(assetRules("interface", src).accepts("S1TTXX-firmware-3.1.0.bin"), true);
});

test("a source can rename its assets", () => {
  const src = { provider: "github", repo: "a/b", assetPattern: "^board-app-v[0-9.]+\\.bin$" };
  assert.equal(assetRules("interface", src).accepts("board-app-v2.0.1.bin"), true);
  assert.equal(assetRules("interface", src).accepts("S1TTXX-firmware-3.1.0.bin"), false);
});

test("an unconfigured device class resolves to nothing, without touching the network", async () => {
  const warnings = [];
  const r = await resolveCandidate("interface", {
    channel: "stable",
    sources: {},
    token: null,
    cliVersion: [0, 4, 0],
    cacheDir: os.tmpdir(),
    cacheKeepPerKind: 2,
    warnings,
  });
  assert.equal(r, null);
  assert.deepEqual(warnings, []);
});

test("pruning keeps the newest images per class and never the one just resolved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
  const make = (name, ageSeconds) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "x");
    const t = Date.now() / 1000 - ageSeconds;
    fs.utimesSync(p, t, t);
    return p;
  };
  make("interface-v1.0.0-a.bin", 400);
  make("interface-v1.1.0-a.bin", 300);
  const protectedOld = make("interface-v0.9.0-a.bin", 900); // oldest, but in use
  make("interface-v1.2.0-a.bin", 100);
  make("powerbank-v3.0.0-b.bin", 999); // other class: untouched
  make("interface-v9.9.9-a.bin.part", 1); // in-progress download: untouched

  const removed = (await pruneCache(dir, "interface", 2, protectedOld)).map((p) => path.basename(p));
  const left = fs.readdirSync(dir).sort();

  // keep = 2 means two images in total: the one in use plus the newest other.
  assert.deepEqual(
    removed.sort(),
    ["interface-v1.0.0-a.bin", "interface-v1.1.0-a.bin"].sort()
  );
  assert.ok(left.includes("interface-v0.9.0-a.bin"), "the image in use survives");
  assert.ok(left.includes("interface-v1.2.0-a.bin"), "the newest other survives");
  assert.equal(left.filter((n) => n.startsWith("interface-") && n.endsWith(".bin")).length, 2);
  assert.ok(left.includes("powerbank-v3.0.0-b.bin"), "another class is untouched");
  assert.ok(left.includes("interface-v9.9.9-a.bin.part"), "a partial download is untouched");
});
