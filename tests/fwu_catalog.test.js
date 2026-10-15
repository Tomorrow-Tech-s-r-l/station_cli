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

// ---------------------------------------------------------------------------
// `dir` provider: a local release folder, for emulator and bench tests of a
// firmware build before it is published.
// ---------------------------------------------------------------------------

const { ensureImage } = require("../dist/S1TTXX/fwu/catalog");

function localReleases(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fwu-dir-"));
  for (const [rel, body] of Object.entries(layout)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}

function dirOpts(root, extra = {}) {
  return {
    channel: "stable",
    sources: { interface: { provider: "dir", path: root }, powerbank: { provider: "dir", path: root } },
    token: null,
    cliVersion: [0, 4, 0],
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "fwu-cache-")),
    cacheKeepPerKind: 2,
    warnings: [],
    ...extra,
  };
}

test("dir: the newest stable tag folder wins, pre-releases only on beta", async () => {
  const root = localReleases({
    "v3.1.0/S1TTXX-firmware-3.1.0.bin": "a",
    "v3.2.0/S1TTXX-firmware-3.2.0.bin": "bb",
    "dev-v3.3.0/S1TTXX-firmware-3.3.0.bin": "ccc",
    "v3.4.0/S1TTXX-firmware-3.4.0.bin": "dddd",
    "v3.4.0/PRERELEASE": "",
  });
  const stable = await resolveCandidate("interface", dirOpts(root));
  assert.equal(stable.tag, "v3.2.0");
  assert.equal(stable.prerelease, false);
  assert.equal(stable.assetSizeBytes, 2);
  const beta = await resolveCandidate("interface", dirOpts(root, { channel: "beta" }));
  assert.equal(beta.tag, "v3.4.0");
  assert.equal(beta.prerelease, true);
});

test("dir: flat .bin files take their version from the file name", async () => {
  const root = localReleases({
    "P1TT2C-firmware-3.1.0.bin": "x",
    "P1TT2C-firmware-3.2.5.bin": "yy",
    "P1TT2C-firmware-9.9.9-merged.bin": "never",
  });
  const c = await resolveCandidate("powerbank", dirOpts(root));
  assert.equal(c.tag, "v3.2.5");
  assert.equal(c.assetName, "P1TT2C-firmware-3.2.5.bin");
});

test("dir: the merged/bootloader floor and the CLI floor still apply", async () => {
  const root = localReleases({
    "v4.0.0/S1TTXX-merged-4.0.0.bin": "never",
    "v3.9.0/S1TTXX-firmware-3.9.0.bin": "z",
    "v3.9.0/metadata.json": JSON.stringify({ min_cli_version: "9.0.0" }),
    "v3.8.0/S1TTXX-firmware-3.8.0.bin": "ok",
  });
  const o = dirOpts(root);
  const c = await resolveCandidate("interface", o);
  assert.equal(c.tag, "v3.8.0");
  assert.ok(o.warnings.some((w) => /v4\.0\.0.*no asset/.test(w)));
  assert.ok(o.warnings.some((w) => /v3\.9\.0.*needs station-cli >= 9\.0\.0/.test(w)));
});

test("dir: the image is copied into the cache and reused when intact", async () => {
  const root = localReleases({ "v3.2.0/S1TTXX-firmware-3.2.0.bin": Buffer.from([1, 2, 3, 4]) });
  const o = dirOpts(root);
  const c = await resolveCandidate("interface", o);
  const p1 = await ensureImage(c, o);
  assert.deepEqual([...fs.readFileSync(p1)], [1, 2, 3, 4]);
  assert.ok(p1.startsWith(o.cacheDir));
  const p2 = await ensureImage(c, o);
  assert.equal(p2, p1);
  assert.equal(fs.existsSync(`${p1}.part`), false);
});

test("dir: a missing folder is a warning, not a crash", async () => {
  const o = dirOpts("/nonexistent/fwu-dir");
  assert.equal(await resolveCandidate("interface", o), null);
  assert.ok(o.warnings[0].startsWith("Cannot read firmware folder /nonexistent/fwu-dir"));
});
