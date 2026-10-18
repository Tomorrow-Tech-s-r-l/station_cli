// Firmware candidate selection from compatibility.json (catalog.ts
// selectGithubCandidate + engine.ts installedSet), and where the file comes
// from (compat/source.ts): network, cache, bundled copy, or nothing (fail
// closed). Release listings are the real tags of the firmware repositories
// (tests/fixtures/releases) with synthetic assets. Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { selectGithubCandidate } = require("../../dist/S1TTXX/fwu/catalog");
const { installedSet } = require("../../dist/S1TTXX/fwu/engine");
const { loadCompatibility } = require("../../dist/compat/source");
const { parseCompatibility } = require("../../dist/compat/compatibility");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const compatText = fs.readFileSync(path.join(FIXTURES, "compat", "compatibility.json"), "utf8");
const compatDoc = () => parseCompatibility(compatText).doc;
const SOURCES = {
  interface: { provider: "github", repo: "Tomorrow-Tech-s-r-l/S1TTXX-firmware" },
  powerbank: { provider: "github", repo: "Tomorrow-Tech-s-r-l/P1TT2C-firmware" },
};

/** GitHub API shape from a fixture listing, one app image per release. */
function githubReleases(name, family) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, "releases", `${name}.json`), "utf8")).map((r, i) => ({
    tag_name: r.tagName,
    draft: r.isDraft,
    prerelease: r.isPrerelease,
    assets: [
      { name: `${family}-merged-${r.tagName.replace(/^(dev-)?v/, "")}.bin`, url: `https://api.github.com/assets/m${i}`, size: 9 },
      { name: `${family}-firmware-${r.tagName.replace(/^(dev-)?v/, "")}.bin`, url: `https://api.github.com/assets/${i}`, size: 100 + i },
      { name: "metadata.json", url: `https://api.github.com/assets/meta${i}`, size: 50 },
    ],
  }));
}
const boards = githubReleases("S1TTXX-firmware", "S1TTXX");
const packs = githubReleases("P1TT2C-firmware", "P1TT2C");

function device(kind, version, extra = {}) {
  return {
    kind,
    boardAddress: 0,
    slotIndex: kind === "powerbank" ? 1 : null,
    name: null,
    versionRaw: version,
    version: version ? version.split(".").map(Number) : null,
    status: 0,
    reachable: true,
    error: null,
    ...extra,
  };
}

function opts({ channel = "stable", cliVersion = [0, 5, 0], cliTag = "dev-v0.5.0", interfaces = [], powerbanks = [], doc = compatDoc() } = {}) {
  const compat = doc ? { doc, origin: "network", location: "x", sequence: doc.sequence, generatedAt: null, error: null } : null;
  return {
    channel,
    sources: SOURCES,
    token: null,
    cliVersion,
    cacheDir: os.tmpdir(),
    cacheKeepPerKind: 2,
    warnings: [],
    compat,
    installed: doc ? installedSet(doc, { cliVersion, channel, cliTag }, interfaces, powerbanks) : [],
  };
}

test("catalog: stable picks the newest production release the rule accepts", () => {
  const o = opts({ interfaces: [device("interface", "3.0.1")], powerbanks: [device("powerbank", "3.0.2")] });
  const c = selectGithubCandidate("interface", SOURCES.interface, boards, o);
  assert.equal(c.tag, "v3.0.3");
  assert.deepEqual(c.version, [3, 0, 3]);
  assert.equal(c.prerelease, false);
  assert.equal(c.assetName, "S1TTXX-firmware-3.0.3.bin", "never the merged image");
  assert.deepEqual(c.minCliVersion, [0, 3, 1], "the CLI floor comes from compatibility.json");
  assert.equal(c.compat.sequence, 42);
});

test("catalog: beta skips a newer release whose pack floor is broken", () => {
  // dev-v3.2.0 is newest but compatible with no pack: v3.0.3 is offered.
  const o = opts({ channel: "beta", interfaces: [device("interface", "3.0.3")], powerbanks: [device("powerbank", "3.0.2")] });
  const c = selectGithubCandidate("interface", SOURCES.interface, boards, o);
  assert.equal(c.tag, "v3.0.3");
  assert.ok(o.warnings.some((w) => /dev-v3\.2\.0 .*not installable here: .*no compatible P1TT2C/.test(w)), o.warnings.join("\n"));
});

test("catalog: an old CLI is refused by the firmware's own floor", () => {
  const o = opts({ cliVersion: [0, 3, 0], cliTag: "v0.3.0", interfaces: [device("interface", "3.0.1")] });
  const c = selectGithubCandidate("interface", SOURCES.interface, boards, o);
  assert.equal(c, null, "every tested release needs station_cli >= 0.3.1");
  assert.ok(o.warnings.some((w) => /v3\.0\.3 .*needs station_cli >= 0\.3\.1/.test(w)));
  // v0.3.0's own floor (S1TTXX >= 3.0.3) also refuses v3.0.1: the reverse rule.
  assert.ok(o.warnings.some((w) => /v3\.0\.1 .*this station-cli \(station_cli v0\.3\.0\) needs S1TTXX >= 3\.0\.3/.test(w)));
});

test("catalog: untested releases are never offered", () => {
  // v2.0.x are real tags but not in compatibility.json.
  const d = compatDoc();
  for (const t of ["v3.0.3", "v3.0.1", "dev-v3.2.0"]) delete d.components.S1TTXX.releases[t];
  const o = opts({ doc: d, interfaces: [device("interface", "2.0.0")] });
  assert.equal(selectGithubCandidate("interface", SOURCES.interface, boards, o), null);
  assert.ok(o.warnings.some((w) => /v2\.0\.2 .*untested/.test(w)));
});

test("catalog: a pack image needs a board version that accepts it", () => {
  const withBoard = opts({ interfaces: [device("interface", "3.0.3")], powerbanks: [device("powerbank", "3.0.0")] });
  assert.equal(selectGithubCandidate("powerbank", SOURCES.powerbank, packs, withBoard).tag, "v3.0.2");

  const oldBoard = opts({ interfaces: [device("interface", "3.0.1")], powerbanks: [device("powerbank", "3.0.0")] });
  assert.equal(selectGithubCandidate("powerbank", SOURCES.powerbank, packs, oldBoard), null, "every pack needs S1TTXX >= 3.0.3");

  const noBoard = opts({ interfaces: [device("interface", null, { reachable: false })] });
  assert.equal(selectGithubCandidate("powerbank", SOURCES.powerbank, packs, noBoard), null);
  assert.ok(noBoard.warnings.some((w) => /no interface board firmware version could be read/.test(w)));
});

test("catalog: no compatibility data fails closed", () => {
  const o = opts({ doc: null });
  assert.equal(selectGithubCandidate("interface", SOURCES.interface, boards, o), null);
  assert.match(o.warnings[0], /fail closed/);
});

test("catalog: a source that is not the repository the file describes is refused", () => {
  const o = opts({ interfaces: [device("interface", "3.0.1")] });
  const fork = { provider: "github", repo: "someone/S1TTXX-fork" };
  assert.equal(selectGithubCandidate("interface", fork, boards, o), null);
  assert.match(o.warnings[0], /describes S1TTXX releases of Tomorrow-Tech-s-r-l\/S1TTXX-firmware/);
});

test("catalog: drafts and tags outside the grammar are ignored", () => {
  const extra = [
    { tag_name: "v9.9.9", draft: true, assets: [{ name: "S1TTXX-firmware-9.9.9.bin", url: "u" }] },
    { tag_name: "nightly", assets: [{ name: "S1TTXX-firmware-9.9.8.bin", url: "u" }] },
  ];
  const d = compatDoc();
  d.components.S1TTXX.releases["v9.9.9"] = { version: "9.9.9", channel: "production", requires: d.components.S1TTXX.releases["v3.0.3"].requires };
  const o = opts({ doc: d, interfaces: [device("interface", "3.0.1")], powerbanks: [device("powerbank", "3.0.2")] });
  assert.equal(selectGithubCandidate("interface", SOURCES.interface, [...extra, ...boards], o).tag, "v3.0.3");
});

// --- where compatibility.json comes from ---------------------------------------

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "compat-src-"));
}
const SRC = { repo: "Tomorrow-Tech-s-r-l/release-compat", tag: "current", asset: "compatibility.json" };
const withSeq = (n) => JSON.stringify({ ...JSON.parse(compatText), sequence: n });

test("source: the published file is used and cached", async () => {
  const dir = tmp();
  const cacheFile = path.join(dir, "cache", "compatibility.json");
  const warnings = [];
  const r = await loadCompatibility({ source: SRC, token: null, cacheFile, bundledFile: null, warnings, fetch: async () => Buffer.from(withSeq(43)) });
  assert.equal(r.origin, "network");
  assert.equal(r.sequence, 43);
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).sequence, 43);
  assert.deepEqual(warnings, []);
});

test("source: offline, the cache is used; then the bundled copy; then nothing", async () => {
  const dir = tmp();
  const cacheFile = path.join(dir, "compatibility.json");
  const bundledFile = path.join(dir, "bundled.json");
  const offline = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  };

  fs.writeFileSync(bundledFile, withSeq(40));
  let r = await loadCompatibility({ source: SRC, token: null, cacheFile, bundledFile, warnings: [], fetch: offline });
  assert.equal(r.origin, "bundled");
  assert.match(r.error, /ENOTFOUND/);

  fs.writeFileSync(cacheFile, withSeq(41));
  r = await loadCompatibility({ source: SRC, token: null, cacheFile, bundledFile, warnings: [], fetch: offline });
  assert.equal(r.origin, "cache", "the newer of cache and bundled");

  const warnings = [];
  r = await loadCompatibility({ source: SRC, token: null, cacheFile: path.join(dir, "none.json"), bundledFile: null, warnings, fetch: offline });
  assert.equal(r.origin, "none");
  assert.equal(r.doc, null);
  assert.ok(warnings.some((w) => /no firmware will be installed/.test(w)));
});

test("source: an invalid or stale published file never replaces a good cache", async () => {
  const dir = tmp();
  const cacheFile = path.join(dir, "compatibility.json");
  fs.writeFileSync(cacheFile, withSeq(50));

  let r = await loadCompatibility({ source: SRC, token: null, cacheFile, bundledFile: null, warnings: [], fetch: async () => Buffer.from('{"format":"nope"}') });
  assert.equal(r.origin, "cache");
  assert.match(r.error, /invalid/);

  const warnings = [];
  r = await loadCompatibility({ source: SRC, token: null, cacheFile, bundledFile: null, warnings, fetch: async () => Buffer.from(withSeq(49)) });
  assert.equal(r.origin, "cache");
  assert.equal(r.sequence, 50);
  assert.ok(warnings.some((w) => /older than the cached 50/.test(w)));
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, "utf8")).sequence, 50, "cache untouched");
});

test("installed set: one entry per distinct version, bootloader-only devices left out", () => {
  const d = compatDoc();
  const set = installedSet(
    d,
    { cliVersion: [0, 5, 0], channel: "stable", cliTag: "dev-v0.5.0" },
    [device("interface", "3.0.3"), { ...device("interface", "3.0.3"), boardAddress: 1 }, device("interface", null, { inBootloader: true, reachable: false })],
    [device("powerbank", "3.0.2"), device("powerbank", null, { reachable: false })]
  );
  assert.deepEqual(
    set.map((s) => [s.component, s.label, s.interpretations.map((i) => i.tag)]),
    [
      ["station_cli", "this station-cli", ["dev-v0.5.0"]],
      ["S1TTXX", "interface board 0, interface board 1", ["v3.0.3"]],
      ["P1TT2C", "powerbank slot 1", ["v3.0.2"]],
    ]
  );
});
