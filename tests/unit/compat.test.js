// compatibility.json: SemVer precedence, the tag grammar, validation and the
// consumer rule (src/compat). Fixtures: tests/fixtures/compat (a document in
// release-compat's compatibility/v1 shape) and tests/fixtures/releases (the
// real release lists of the four repositories). Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseSemVer, compareSemVer, formatSemVer, classifyTag } = require("../../dist/compat/semver");
const {
  validateCompatibility,
  parseCompatibility,
  checkInstall,
  interpretInstalled,
  channelFloor,
  stationChannel,
  cutoverOf,
  isLegacy,
} = require("../../dist/compat/compatibility");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const compatText = fs.readFileSync(path.join(FIXTURES, "compat", "compatibility.json"), "utf8");
const doc = () => JSON.parse(compatText);
const releases = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, "releases", `${name}.json`), "utf8"));

const v = (s) => {
  const p = parseSemVer(s);
  assert.ok(p, `parses ${s}`);
  return p;
};

// --- SemVer ----------------------------------------------------------------

test("semver: a pre-release ranks below its release", () => {
  assert.ok(compareSemVer(v("0.5.0-dev"), v("0.5.0")) < 0);
  assert.ok(compareSemVer(v("0.5.0"), v("0.5.0-dev")) > 0);
  assert.ok(compareSemVer(v("0.4.9"), v("0.5.0-dev")) < 0);
  assert.equal(compareSemVer(v("v1.2.3"), v("1.2.3+build.7")), 0, "build metadata does not order");
});

test("semver: dev.N compares numerically, not as text", () => {
  assert.ok(compareSemVer(v("1.4.0-dev.2"), v("1.4.0-dev.10")) < 0);
  assert.ok(compareSemVer(v("1.4.0-dev.23"), v("1.4.0")) < 0);
  assert.ok(compareSemVer(v("1.4.0-dev"), v("1.4.0-dev.1")) < 0, "fewer identifiers rank lower");
  assert.ok(compareSemVer(v("1.0.0-1"), v("1.0.0-alpha")) < 0, "numeric below alphanumeric");
});

test("semver: only full versions parse", () => {
  for (const bad of ["1.2", "01.2.3", "1.2.3-01", "1.2.3-", "x.y.z", "", null, "dev-v1.2.3"]) {
    assert.equal(parseSemVer(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(formatSemVer(v("3.2.0-dev")), "3.2.0-dev");
  assert.equal(formatSemVer(v("v1.4.0-dev.23")), "1.4.0-dev.23");
});

// --- tag grammar -------------------------------------------------------------

test("tags: firmware and CLI grammar, by tag text only", () => {
  assert.deepEqual(classifyTag("S1TTXX", "dev-v3.2.0"), {
    tag: "dev-v3.2.0",
    version: { major: 3, minor: 2, patch: 0, prerelease: ["dev"] },
    channel: "development",
  });
  assert.equal(classifyTag("P1TT2C", "v3.0.2").channel, "production");
  assert.equal(classifyTag("station_cli", "v0.5.0-dev.1"), null, "kiosk grammar is not the CLI's");
  assert.equal(classifyTag("S1TTXX", "3.0.3"), null);
});

test("tags: kiosk grammar, legacy timestamp tags dropped", () => {
  assert.equal(classifyTag("kiosk", "v1.4.0-dev.23").channel, "development");
  assert.equal(formatSemVer(classifyTag("kiosk", "v1.4.0-dev.23").version), "1.4.0-dev.23");
  assert.equal(classifyTag("kiosk", "v1.3.17").channel, "production");
  assert.equal(classifyTag("kiosk", "20250101120000-1-abcdef0"), null);
  assert.equal(classifyTag("kiosk", "dev-v1.3.0"), null);
});

test("tags: the real release lists sort by precedence, not by publish date", () => {
  const sorted = (component, file) =>
    releases(file)
      .map((r) => classifyTag(component, r.tagName))
      .filter(Boolean)
      .sort((a, b) => compareSemVer(b.version, a.version))
      .map((c) => c.tag);

  const cli = sorted("station_cli", "station_cli");
  assert.equal(cli[0], "dev-v0.5.0");
  assert.ok(cli.indexOf("v0.3.1") < cli.indexOf("dev-v0.3.1"), "v0.3.1 > dev-v0.3.1");
  assert.ok(cli.indexOf("v0.2.4") < cli.indexOf("dev-v0.2.4"));

  const kiosk = sorted("kiosk", "amperry-kiosk-local");
  assert.equal(kiosk[0], "v1.4.0-dev.23");
  assert.ok(kiosk.indexOf("v1.3.17") < kiosk.indexOf("v1.3.17-dev.16"));
  // The listing publishes v1.3.17 AFTER v1.4.0-dev.21 — date order would lie.
  assert.ok(kiosk.indexOf("v1.4.0-dev.21") < kiosk.indexOf("v1.3.17"));

  assert.deepEqual(sorted("S1TTXX", "S1TTXX-firmware"), ["dev-v3.2.0", "v3.0.3", "v3.0.1", "v2.0.2", "v2.0.1", "v2.0.0"]);
  assert.deepEqual(sorted("P1TT2C", "P1TT2C-firmware").slice(0, 2), ["dev-v3.1.0", "v3.0.2"]);
  // isPrerelease agrees with the tag on these lists; the grammar is what counts.
  for (const r of releases("S1TTXX-firmware")) {
    assert.equal(classifyTag("S1TTXX", r.tagName).channel === "development", r.isPrerelease);
  }
});

// --- validation ----------------------------------------------------------------

test("validation: the fixture is a valid compatibility/v1 document", () => {
  const r = parseCompatibility(compatText);
  assert.deepEqual(r.errors, []);
  assert.equal(r.doc.sequence, 42);
});

test("validation: any structural error rejects the whole file", () => {
  const cases = [
    [(d) => (d.format = "compatibility/v2"), /format/],
    [(d) => (d.sequence = -1), /sequence/],
    [(d) => (d.edges = [["S1TTXX"]]), /edges/],
    [(d) => delete d.components.S1TTXX.releases["v3.0.3"].requires.P1TT2C.no_compatible, /no_compatible/],
    [(d) => (d.components.S1TTXX.releases["v3.0.3"].requires.P1TT2C.min = "3.0"), /min/],
    [(d) => (d.components.P1TT2C.releases["v3.0.2"].channel = "beta"), /channel/],
    [(d) => (d.components.P1TT2C.releases["v3.0.2"].version = "latest"), /version/],
    [(d) => (d.components.S1TTXX.releases["v3.0.3"].requires.P1TT2C.channels = []), /channels/],
    [(d) => (d.components.S1TTXX.releases["v3.0.3"].requires.P1TT2C.channels = { production: floor("3.0.2") }), /channels\.development/],
    [(d) => (d.components.S1TTXX.releases["v3.0.3"].requires.P1TT2C.channels = { production: { ...floor("3.0.2"), min: "3" }, development: floor("3.0.2") }), /channels\.production\.min/],
    [(d) => (d.components.S1TTXX.releases["v3.0.3"].requires.P1TT2C.channels = { production: floor("3.0.2"), development: { min: null, min_tag: null } }), /channels\.development\.no_compatible/],
  ];
  for (const [mutate, pattern] of cases) {
    const d = doc();
    mutate(d);
    const r = validateCompatibility(d);
    assert.equal(r.doc, null);
    assert.ok(r.errors.some((e) => pattern.test(e)), `${pattern}: ${r.errors.join("; ")}`);
  }
  assert.equal(parseCompatibility("{not json").doc, null);
});

// A per-channel floor (release-compat's `floor` def).
function floor(min, extra = {}) {
  return { min, min_tag: min ? `v${min}` : null, no_compatible: min === null, tested: [], failed: [], ...extra };
}

// --- what is installed -----------------------------------------------------------

test("installed: a bare X.Y.Z can be the release or its dev build", () => {
  const d = doc();
  // Only dev-v3.2.0 is listed: the board reporting 3.2.0 is that build.
  assert.deepEqual(
    interpretInstalled(d, "S1TTXX", "3.2.0", "board 0").interpretations.map((i) => i.tag),
    ["dev-v3.2.0"]
  );
  // Both builds listed: both interpretations — the update channel does not
  // say which build a device runs (release-compat's readings).
  d.components.S1TTXX.releases["v3.2.0"] = { version: "3.2.0", channel: "production", requires: {} };
  assert.deepEqual(
    interpretInstalled(d, "S1TTXX", "3.2.0", "board 0").interpretations.map((i) => i.tag).sort(),
    ["dev-v3.2.0", "v3.2.0"]
  );
  // Only the `-dev` pre-release is a build of the bare version.
  d.components.S1TTXX.releases["v3.2.0-rc"] = { version: "3.2.0-rc.1", channel: "development", requires: {} };
  assert.deepEqual(
    interpretInstalled(d, "S1TTXX", "3.2.0", "board 0").interpretations.map((i) => i.tag).sort(),
    ["dev-v3.2.0", "v3.2.0"]
  );
  // A version the file does not list counts as itself.
  const unknown = interpretInstalled(d, "S1TTXX", "9.9.9", "board 0");
  assert.equal(unknown.interpretations[0].tag, null);
  assert.equal(formatSemVer(unknown.interpretations[0].version), "9.9.9");
  // The CLI knows its own tag.
  const self = interpretInstalled(d, "station_cli", "0.5.0", "cli", { tag: "dev-v0.5.0" });
  assert.equal(formatSemVer(self.interpretations[0].version), "0.5.0-dev");
});

// --- the consumer rule -------------------------------------------------------------

const cli = (d, tag) => interpretInstalled(d, "station_cli", tag.replace(/^(dev-)?v/, ""), "this station-cli", { tag });
const board = (d, version) => interpretInstalled(d, "S1TTXX", version, "interface board 0");
const pack = (d, version) => interpretInstalled(d, "P1TT2C", version, "powerbank slot 1");

test("rule 1: a release the file does not list is not installable", () => {
  const d = doc();
  const r = checkInstall(d, "S1TTXX", "v9.0.0", [cli(d, "dev-v0.5.0")]);
  assert.equal(r.installable, false);
  assert.match(r.reasons[0], /untested/);
});

test("rule 2: the release's floor towards each installed component", () => {
  const d = doc();
  assert.equal(checkInstall(d, "S1TTXX", "v3.0.3", [cli(d, "dev-v0.5.0"), pack(d, "3.0.2")]).installable, true);

  const oldCli = checkInstall(d, "S1TTXX", "dev-v3.2.0", [cli(d, "v0.3.1")]);
  assert.equal(oldCli.installable, false);
  assert.match(oldCli.reasons.join(), /needs station_cli >= 0\.4\.0/);

  // dev-v3.2.0's newest tested pack failed: no pack is compatible with it.
  const noCompat = checkInstall(d, "S1TTXX", "dev-v3.2.0", [cli(d, "dev-v0.5.0"), pack(d, "3.0.2")]);
  assert.equal(noCompat.installable, false);
  assert.match(noCompat.reasons.join(), /no compatible P1TT2C/);

  // An edge the release was never tested on fails closed.
  const untested = doc();
  delete untested.components.S1TTXX.releases["v3.0.3"].requires.station_cli;
  const r = checkInstall(untested, "S1TTXX", "v3.0.3", [cli(untested, "dev-v0.5.0")]);
  assert.equal(r.installable, false);
  assert.match(r.reasons[0], /never tested with station_cli/);
});

test("rule 2: SemVer pre-release floors (a dev board below a release floor)", () => {
  const d = doc();
  // dev-v3.1.0 needs a board >= 3.2.0-dev: the 3.0.3 board is too old,
  // the dev-v3.2.0 board is enough.
  const old = checkInstall(d, "P1TT2C", "dev-v3.1.0", [cli(d, "dev-v0.5.0"), board(d, "3.0.3")]);
  assert.equal(old.installable, false);
  assert.match(old.reasons.join(), /needs S1TTXX >= 3\.2\.0-dev/);
  // …but the dev-v3.2.0 board itself refuses every pack (no_compatible), reverse rule.
  const dev = checkInstall(d, "P1TT2C", "dev-v3.1.0", [cli(d, "dev-v0.5.0"), board(d, "3.2.0")]);
  assert.equal(dev.installable, false);
  assert.match(dev.reasons.join(), /interface board 0 \(S1TTXX dev-v3\.2\.0\) has no compatible P1TT2C/);
});

test("rule 3: the installed release's own floor towards the candidate", () => {
  const d = doc();
  // v3.0.1 accepts pack 3.0.2 (forward), but pack v3.0.2 needs a board >= 3.0.3.
  const r = checkInstall(d, "S1TTXX", "v3.0.1", [cli(d, "dev-v0.5.0"), pack(d, "3.0.2")]);
  assert.equal(r.installable, false);
  assert.match(r.reasons.join(), /powerbank slot 1 \(P1TT2C v3\.0\.2\) needs S1TTXX >= 3\.0\.3; v3\.0\.1 is older/);
  // The installed CLI's own floor: v0.3.1 accepts S1TTXX >= 3.0.1.
  assert.equal(checkInstall(d, "S1TTXX", "v3.0.1", [cli(d, "v0.3.1")]).installable, true);
});

test("rule 2: every interpretation of an ambiguous device must pass", () => {
  const d = doc();
  d.components.S1TTXX.releases["v3.2.0"] = { version: "3.2.0", channel: "production", requires: {} };
  // P1TT2C v3.0.2 needs S1TTXX >= 3.0.3; "3.2.0" passes as both builds — but
  // the dev build refuses all packs, and a board reporting 3.2.0 may be
  // running it (on either update channel), so the pack is refused.
  const r = checkInstall(d, "P1TT2C", "v3.0.2", [cli(d, "dev-v0.5.0"), board(d, "3.2.0")]);
  assert.equal(r.installable, false);
  assert.match(r.reasons.join(), /S1TTXX dev-v3\.2\.0\) has no compatible P1TT2C/);
});

test("components without an edge do not constrain each other", () => {
  const d = doc();
  const kiosk = { component: "kiosk", label: "kiosk", interpretations: [{ tag: "v0.0.1", version: v("0.0.1") }] };
  assert.equal(checkInstall(d, "S1TTXX", "v3.0.3", [cli(d, "dev-v0.5.0"), kiosk]).installable, true);
});

// --- floors per installing channel --------------------------------------------

test("channels: stable stations read production floors, beta ones development floors", () => {
  assert.equal(stationChannel("stable"), "production");
  assert.equal(stationChannel("beta"), "development");
  const req = { ...floor(null), evidence: [], channels: { production: floor("3.0.2"), development: floor(null) } };
  assert.equal(channelFloor(req, "production").min, "3.0.2");
  assert.equal(channelFloor(req, "development").min, null);
  assert.equal(channelFloor(req, null), req, "no channel: the top level");
  const legacy = { ...floor("3.0.0"), evidence: [] };
  assert.equal(channelFloor(legacy, "production"), legacy, "no channels block: the top level");
  assert.equal(channelFloor(undefined, "production"), undefined);
});

test("channels: rule 2 and rule 3 use the installing station's channel", () => {
  const d = doc();
  // dev-v3.2.0's pack floor: none over both channels (the dev pack fails),
  // v3.0.2 over production packs.
  const board = d.components.S1TTXX.releases["dev-v3.2.0"].requires.P1TT2C;
  board.channels = { production: floor("3.0.2", { tested: ["v3.0.2"] }), development: floor(null, { reason: "newest_failed" }) };
  const installed = [cli(d, "dev-v0.5.0"), pack(d, "3.0.2")];
  assert.equal(checkInstall(d, "S1TTXX", "dev-v3.2.0", installed, { channel: "production" }).installable, true);
  const dev = checkInstall(d, "S1TTXX", "dev-v3.2.0", installed, { channel: "development" });
  assert.equal(dev.installable, false);
  assert.equal(dev.channel, "development");
  assert.match(dev.reasons.join(), /no compatible P1TT2C release for a development station \(newest tested failed\)/);
  assert.equal(checkInstall(d, "S1TTXX", "dev-v3.2.0", installed).installable, false, "no channel: the top level");

  // Rule 3: the installed board's own pack floor, per channel.
  const onBoard = [cli(d, "dev-v0.5.0"), interpretInstalled(d, "S1TTXX", "3.2.0-dev", "interface board 0")];
  assert.equal(checkInstall(d, "P1TT2C", "v3.0.2", onBoard, { channel: "production" }).installable, true);
  assert.match(
    checkInstall(d, "P1TT2C", "v3.0.2", onBoard, { channel: "development" }).reasons.join(),
    /S1TTXX dev-v3\.2\.0\) has no compatible P1TT2C release for a development station/
  );
});

test("channels: a channel nothing was tested on blocks that channel only", () => {
  const d = doc();
  const req = d.components.station_cli.releases["dev-v0.5.0"].requires.S1TTXX;
  req.channels = { production: floor(null, { reason: "untested" }), development: floor(req.min) };
  const boardOn = [interpretInstalled(d, "S1TTXX", "3.0.3", "interface board 0", { tag: "v3.0.3" })];
  const r = checkInstall(d, "station_cli", "dev-v0.5.0", boardOn, { channel: "production" });
  assert.equal(r.installable, false);
  assert.match(r.reasons.join(), /none of that channel was tested/);
  assert.equal(checkInstall(d, "station_cli", "dev-v0.5.0", boardOn, { channel: "development" }).installable, true);
});

// --- the cutover (legacy vs enforced releases) -----------------------------------

test("cutover: enforced_from absent = classic, null = every release legacy, a tag = legacy below it", () => {
  const d = doc();
  assert.equal(cutoverOf(d, "S1TTXX"), undefined);
  assert.equal(isLegacy(d, "S1TTXX", v("3.0.3")), false, "a file without enforced_from enforces everything");
  d.components.S1TTXX.enforced_from = null;
  assert.equal(isLegacy(d, "S1TTXX", v("3.0.3")), true);
  d.components.S1TTXX.enforced_from = "v3.1.0";
  assert.equal(isLegacy(d, "S1TTXX", v("3.0.3")), true);
  assert.equal(isLegacy(d, "S1TTXX", v("3.1.0-dev")), true, "dev-v3.1.0 predates v3.1.0");
  assert.equal(isLegacy(d, "S1TTXX", v("3.1.0")), false);
  assert.equal(isLegacy(d, "S1TTXX", v("3.2.0")), false);
  d.components.S1TTXX.enforced_from = "nightly";
  assert.equal(isLegacy(d, "S1TTXX", v("1.0.0")), false, "an unreadable cutover enforces");
});

test("cutover: validation accepts enforced_from tag/null and untested_legacy, rejects other shapes", () => {
  const d = doc();
  d.components.S1TTXX.enforced_from = null;
  d.components.S1TTXX.enforced_from_version = null;
  d.components.station_cli.enforced_from = "v0.6.0";
  d.components.station_cli.enforced_from_version = "0.6.0";
  d.components.S1TTXX.releases["v3.0.3"].requires.station_cli.untested_legacy = ["v0.2.1"];
  assert.deepEqual(validateCompatibility(d).errors, []);
  d.components.S1TTXX.enforced_from = 3;
  d.components.station_cli.enforced_from_version = "six";
  d.components.S1TTXX.releases["v3.0.3"].requires.station_cli.untested_legacy = "v0.2.1";
  const { doc: bad, errors } = validateCompatibility(d);
  assert.equal(bad, null);
  assert.equal(errors.length, 3, errors.join("\n"));
});

test("cutover: a legacy release without evidence on a pair is left to its legacy rule", () => {
  const d = doc();
  for (const id of Object.keys(d.components)) d.components[id].enforced_from = null;
  // v3.0.1 was never tested with any CLI.
  delete d.components.S1TTXX.releases["v3.0.1"].requires.station_cli;
  const r = checkInstall(d, "S1TTXX", "v3.0.1", [cli(d, "v0.2.4")]);
  assert.equal(r.installable, true, r.reasons.join());
  assert.equal(r.legacy, true);
  assert.deepEqual(r.untestedLegacy, ["station_cli"]);
  assert.ok(r.notes.some((n) => /^untested-legacy: legacy v3\.0\.1 was never tested with station_cli/.test(n)), r.notes.join());

  // Not in the file at all: every installed neighbour is left to the legacy rule.
  const gone = checkInstall(d, "S1TTXX", "v2.0.0", [cli(d, "dev-v0.5.0"), pack(d, "3.0.2")]);
  assert.equal(gone.installable, true);
  assert.deepEqual(gone.untestedLegacy.sort(), ["P1TT2C", "station_cli"]);
});

test("cutover: a TESTED failure still blocks a legacy pair", () => {
  const d = doc();
  for (const id of Object.keys(d.components)) d.components[id].enforced_from = null;
  const r = checkInstall(d, "S1TTXX", "v3.0.3", [cli(d, "v0.3.0")]);
  assert.equal(r.legacy, true);
  assert.equal(r.installable, false);
  assert.match(r.reasons.join(), /needs station_cli >= 0\.3\.1/);
  assert.deepEqual(r.untestedLegacy, []);
});

test("cutover: an enforced release needs a floor for every edge, installed or not", () => {
  const d = doc();
  d.components.S1TTXX.enforced_from = "v3.0.3";
  delete d.components.S1TTXX.releases["v3.0.3"].requires.P1TT2C;
  const r = checkInstall(d, "S1TTXX", "v3.0.3", [cli(d, "dev-v0.5.0")]);
  assert.equal(r.legacy, false);
  assert.equal(r.installable, false, "no pack is docked, yet the missing pack floor refuses it");
  assert.match(r.reasons.join(), /enforced and has no computed floor for P1TT2C/);
  assert.equal(checkInstall(d, "S1TTXX", "v9.0.0", [cli(d, "dev-v0.5.0")]).installable, false, "enforced and untested");
});
