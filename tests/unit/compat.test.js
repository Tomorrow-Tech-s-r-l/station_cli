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

// --- what is installed -----------------------------------------------------------

test("installed: a bare X.Y.Z can be the release or its dev build", () => {
  const d = doc();
  // Only dev-v3.2.0 is listed: the board reporting 3.2.0 is that build.
  assert.deepEqual(
    interpretInstalled(d, "S1TTXX", "3.2.0", "board 0").interpretations.map((i) => i.tag),
    ["dev-v3.2.0"]
  );
  // Both builds listed: both interpretations, unless the channel says which.
  d.components.S1TTXX.releases["v3.2.0"] = { version: "3.2.0", channel: "production", requires: {} };
  assert.deepEqual(
    interpretInstalled(d, "S1TTXX", "3.2.0", "board 0").interpretations.map((i) => i.tag).sort(),
    ["dev-v3.2.0", "v3.2.0"]
  );
  assert.deepEqual(
    interpretInstalled(d, "S1TTXX", "3.2.0", "board 0", { channelHint: "production" }).interpretations.map((i) => i.tag),
    ["v3.2.0"]
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
const board = (d, version, hint = null) => interpretInstalled(d, "S1TTXX", version, "interface board 0", { channelHint: hint });
const pack = (d, version, hint = null) => interpretInstalled(d, "P1TT2C", version, "powerbank slot 1", { channelHint: hint });

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
  const r = checkInstall(d, "S1TTXX", "v3.0.1", [cli(d, "dev-v0.5.0"), pack(d, "3.0.2", "production")]);
  assert.equal(r.installable, false);
  assert.match(r.reasons.join(), /powerbank slot 1 \(P1TT2C v3\.0\.2\) needs S1TTXX >= 3\.0\.3; v3\.0\.1 is older/);
  // The installed CLI's own floor: v0.3.1 accepts S1TTXX >= 3.0.1.
  assert.equal(checkInstall(d, "S1TTXX", "v3.0.1", [cli(d, "v0.3.1")]).installable, true);
});

test("rule 2: every interpretation of an ambiguous device must pass", () => {
  const d = doc();
  d.components.S1TTXX.releases["v3.2.0"] = { version: "3.2.0", channel: "production", requires: {} };
  // P1TT2C v3.0.2 needs S1TTXX >= 3.0.3; "3.2.0" passes as both builds — but
  // the dev build refuses all packs, so on the beta channel it is refused…
  assert.equal(checkInstall(d, "P1TT2C", "v3.0.2", [cli(d, "dev-v0.5.0"), board(d, "3.2.0")]).installable, false);
  // …while on the stable channel the board runs the production build.
  assert.equal(
    checkInstall(d, "P1TT2C", "v3.0.2", [cli(d, "dev-v0.5.0"), board(d, "3.2.0", "production")]).installable,
    true
  );
});

test("components without an edge do not constrain each other", () => {
  const d = doc();
  const kiosk = { component: "kiosk", label: "kiosk", interpretations: [{ tag: "v0.0.1", version: v("0.0.1") }] };
  assert.equal(checkInstall(d, "S1TTXX", "v3.0.3", [cli(d, "dev-v0.5.0"), kiosk]).installable, true);
});
