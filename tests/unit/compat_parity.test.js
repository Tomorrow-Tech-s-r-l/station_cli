// The consumer rule against the cases every consumer shares
// (tests/fixtures/compat/consumer-parity.json, a verbatim copy of
// release-compat's test/fixtures/consumer-parity.json), and the catalog fed
// the compatibility.json computed from real contract runs
// (tests/fixtures/compat/compatibility.computed.json: P1TT2C pogo matrix,
// S1TTXX cli_contract with released CLIs, kiosk cli contract). Run with
// `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { checkInstall, interpretInstalled, parseCompatibility } = require("../../dist/compat/compatibility");
const { selectGithubCandidate } = require("../../dist/S1TTXX/fwu/catalog");
const { installedSet } = require("../../dist/S1TTXX/fwu/engine");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const parity = JSON.parse(fs.readFileSync(path.join(FIXTURES, "compat", "consumer-parity.json"), "utf8"));

// A case's `channel` is the installing station's (production | development);
// without one the rule reads the top-level floors.
for (const c of parity.cases) {
  test(`parity [${c.doc}${c.channel ? `, ${c.channel}` : ""}] ${c.name}`, () => {
    const { doc, errors } = parseCompatibility(JSON.stringify(parity.docs[c.doc]));
    assert.deepEqual(errors, []);
    const installed = c.installed.map((i) =>
      interpretInstalled(doc, i.component, i.version ?? "", i.component, { tag: i.tag ?? null })
    );
    assert.ok(installed.every(Boolean), "every installed component is readable");
    const v = checkInstall(doc, c.install.component, c.install.tag, installed, { channel: c.channel ?? null });
    assert.equal(v.installable, c.installable, JSON.stringify({ reasons: v.reasons, notes: v.notes }));
    assert.equal(v.channel, c.channel ?? null);
  });
}

test("parity: the cases cover production, development and no channel", () => {
  const channels = new Set(parity.cases.map((c) => c.channel ?? null));
  assert.deepEqual([...channels].sort(), ["development", "production", null].sort());
});

test("parity: the computed doc is the computed fixture the catalog tests read", () => {
  const computed = JSON.parse(fs.readFileSync(path.join(FIXTURES, "compat", "compatibility.computed.json"), "utf8"));
  assert.deepEqual(parity.docs.computed, computed);
});

// --- the catalog on the computed file ---------------------------------------

const computedText = fs.readFileSync(path.join(FIXTURES, "compat", "compatibility.computed.json"), "utf8");
const SOURCES = {
  interface: { provider: "github", repo: "Tomorrow-Tech-s-r-l/S1TTXX-firmware" },
  powerbank: { provider: "github", repo: "Tomorrow-Tech-s-r-l/P1TT2C-firmware" },
};
function githubReleases(name, family) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, "releases", `${name}.json`), "utf8")).map((r, i) => ({
    tag_name: r.tagName,
    draft: r.isDraft,
    prerelease: r.isPrerelease,
    assets: [{ name: `${family}-firmware-${r.tagName.replace(/^(dev-)?v/, "")}.bin`, url: `https://api.github.com/assets/${i}`, size: 100 + i }],
  }));
}
const boards = githubReleases("S1TTXX-firmware", "S1TTXX");
const packs = githubReleases("P1TT2C-firmware", "P1TT2C");
const device = (kind, version) => ({
  kind, boardAddress: 0, slotIndex: kind === "powerbank" ? 1 : null, name: null, versionRaw: version,
  version: version.split(".").map(Number), status: 0, reachable: true, error: null,
});
function opts({ channel = "stable", cliVersion, cliTag, interfaces = [], powerbanks = [] }) {
  const doc = parseCompatibility(computedText).doc;
  assert.ok(doc, "the computed file validates");
  return {
    channel, sources: SOURCES, token: null, cliVersion, cacheDir: os.tmpdir(), cacheKeepPerKind: 2, warnings: [],
    compat: { doc, origin: "network", location: "x", sequence: doc.sequence, generatedAt: null, error: null },
    installed: installedSet(doc, { cliVersion, channel, cliTag }, interfaces, powerbanks),
  };
}

// channel "stable" (the default here) is a production station, "beta" a
// development one: the floors are those of that channel.
test("computed: a station on v3.0.3 + CLI v0.3.1 with no packs read is offered v3.0.3", async () => {
  const o = opts({ cliVersion: [0, 3, 1], cliTag: "v0.3.1", interfaces: [device("interface", "3.0.3")] });
  const c = await selectGithubCandidate("interface", SOURCES.interface, boards, o);
  assert.equal(c?.tag, "v3.0.3", o.warnings.join("\n"));
  assert.deepEqual(c.minCliVersion, [0, 3, 1], "v0.2.4 fails the board contract (empty slot reported present)");
});

test("computed: stable, packs docked: v3.0.3 is offered (the failing dev pack is not a production release)", async () => {
  const o = opts({ cliVersion: [0, 3, 1], cliTag: "v0.3.1", interfaces: [device("interface", "3.0.3")], powerbanks: [device("powerbank", "3.0.2")] });
  const c = await selectGithubCandidate("interface", SOURCES.interface, boards, o);
  assert.equal(c?.tag, "v3.0.3", o.warnings.join("\n"));
  assert.deepEqual(c.minCliVersion, [0, 3, 1], "the production station_cli floor");
});

test("computed: beta, packs docked: v3.0.3 is offered, dev-v3.2.0 is not (dev pack dev-v3.1.0 fails its tail)", async () => {
  const o = opts({ channel: "beta", cliVersion: [0, 3, 1], cliTag: "v0.3.1", interfaces: [device("interface", "3.0.3")], powerbanks: [device("powerbank", "3.0.2")] });
  const c = await selectGithubCandidate("interface", SOURCES.interface, boards, o);
  assert.equal(c?.tag, "v3.0.3", o.warnings.join("\n"));
  assert.deepEqual(c.minCliVersion, [0, 3, 1], "the development station_cli floor");
  assert.ok(o.warnings.some((w) => /dev-v3\.2\.0/.test(w) && /no compatible P1TT2C release for a development station/.test(w)), o.warnings.join("\n"));
});

test("computed: stable: pack v3.0.2 is offered on a v3.0.3 board", async () => {
  const o = opts({ cliVersion: [0, 3, 1], cliTag: "v0.3.1", interfaces: [device("interface", "3.0.3")], powerbanks: [device("powerbank", "3.0.2")] });
  assert.equal((await selectGithubCandidate("powerbank", SOURCES.powerbank, packs, o))?.tag, "v3.0.2", o.warnings.join("\n"));
});

// On beta, the CLI's own floor refuses every pack: CLIs >= v0.3.1 fail
// dev-v3.1.0's STATUS_EXT tail, so their development floor for P1TT2C is none.
test("computed: beta: no pack firmware is offered next to CLI v0.3.1", async () => {
  const o = opts({ channel: "beta", cliVersion: [0, 3, 1], cliTag: "v0.3.1", interfaces: [device("interface", "3.0.3")], powerbanks: [device("powerbank", "3.0.2")] });
  assert.equal(await selectGithubCandidate("powerbank", SOURCES.powerbank, packs, o), null, o.warnings.join("\n"));
  assert.ok(o.warnings.some((w) => /^Release v3\.0\.2 .*: this station-cli \(station_cli v0\.3\.1\) has no compatible P1TT2C release for a development station/.test(w)), o.warnings.join("\n"));
});

// Every release in the computed file is legacy (enforced_from null: nothing
// was published with computed metadata yet). A tested failure still blocks;
// a pair nobody tested is left to the release's own metadata.json.
test("computed: CLI v0.2.4 is never offered v3.0.3 (tested failure); legacy v3.0.1 falls back to its metadata.json", async () => {
  const asked = [];
  const o = opts({ cliVersion: [0, 2, 4], cliTag: "v0.2.4", interfaces: [device("interface", "3.0.3")] });
  o.legacyMinCli = async (release) => (asked.push(release.tag_name), null);
  const c = await selectGithubCandidate("interface", SOURCES.interface, boards, o);
  assert.ok(o.warnings.some((w) => /^Release v3\.0\.3 .*needs station_cli >= 0\.3\.1/.test(w)), o.warnings.join("\n"));
  assert.equal(c?.tag, "v3.0.1", "v3.0.1 was never tested with a CLI: no computed constraint");
  assert.deepEqual(c.compat.untestedLegacy, ["station_cli"]);
  assert.equal(c.compat.legacy, true);
  assert.equal(c.minCliVersion, null, "its metadata.json declares no floor");
  assert.deepEqual(asked, ["v3.0.1"], "metadata.json is read only for the untested legacy pair");
});

test("computed: a legacy release's metadata.json min_cli_version still refuses an older CLI", async () => {
  const o = opts({ cliVersion: [0, 2, 4], cliTag: "v0.2.4", interfaces: [device("interface", "3.0.3")] });
  o.legacyMinCli = async () => [0, 3, 0];
  assert.equal(await selectGithubCandidate("interface", SOURCES.interface, boards, o), null);
  assert.ok(
    o.warnings.some((w) => /^Release v3\.0\.1 .*\(legacy, never tested with this station-cli\) needs station-cli >= 0\.3\.0 per its metadata\.json, running 0\.2\.4/.test(w)),
    o.warnings.join("\n")
  );
});

test("computed: a legacy release that meets its metadata.json floor carries it as minCliVersion", async () => {
  const o = opts({ cliVersion: [0, 3, 1], cliTag: "v0.3.1", interfaces: [device("interface", "3.0.1")] });
  // Only v3.0.1 and older are listed: none was tested with a CLI.
  const old = boards.filter((b) => /^v(3\.0\.1|2\.)/.test(b.tag_name));
  o.legacyMinCli = async () => [0, 3, 0];
  const c = await selectGithubCandidate("interface", SOURCES.interface, old, o);
  assert.equal(c?.tag, "v3.0.1", o.warnings.join("\n"));
  assert.deepEqual(c.minCliVersion, [0, 3, 0]);
});

// The user's case: a CLI next to a board the harness cannot build.
test("computed: CLI v0.3.1 on a legacy v2.0.0 board with pack v3.0.2 is offered v3.0.3", async () => {
  const o = opts({ cliVersion: [0, 3, 1], cliTag: "v0.3.1", interfaces: [device("interface", "2.0.0")], powerbanks: [device("powerbank", "3.0.2")] });
  o.legacyMinCli = async () => assert.fail("v3.0.3 was tested with the CLI: no legacy fallback");
  const c = await selectGithubCandidate("interface", SOURCES.interface, boards, o);
  assert.equal(c?.tag, "v3.0.3", o.warnings.join("\n"));
  assert.deepEqual(c.compat.untestedLegacy, []);
});
