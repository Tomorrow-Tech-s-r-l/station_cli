// The CI helper scripts of firmware_contract.yml and build.yml: the test
// matrix, the evidence a leg emits, and the release metadata.json (schema 2).
// Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildMatrix, tagsFrom } = require("../../scripts/contract-targets");
const { legResult, legResults, verdict, merge } = require("../../scripts/contract-evidence");
const { buildMetadata, previousTag, previousTags, hasProvenance, clampToPublished, legacyReport, MetadataError } = require("../../scripts/release-metadata");

test("targets: compat targets × packs, branches never get a tag", () => {
  const m = buildMatrix({
    fwTargets: ["v3.0.3", "dev-v3.2.0"],
    packTargets: ["v3.0.2"],
    fwBranches: ["development", "main"],
    packBranches: ["development"],
  });
  assert.equal(m.include.length, 4 * 2);
  const dev = m.include.find((l) => l.fw === "development" && l.pack === "development");
  assert.deepEqual(dev, { fw: "development", fw_ref: "development", fw_tag: "", pack: "development", pack_ref: "development", pack_tag: "" });
  const rel = m.include.find((l) => l.fw === "dev-v3.2.0" && l.pack === "v3.0.2");
  assert.equal(rel.fw_tag, "dev-v3.2.0");
  assert.equal(rel.pack_tag, "v3.0.2");
});

test("targets: without release-compatibility-cli the legacy selectors and the pack branch", () => {
  // The harness has no pack of its own any more (run.sh needs PACK_SRC).
  const m = buildMatrix({ fwBranches: ["development", "main"], packBranches: ["development"] });
  assert.deepEqual(m.include.map((l) => l.fw), ["development", "main", "release", "dev-release"]);
  assert.ok(m.include.every((l) => l.pack === "development" && l.pack_ref === "development" && l.pack_tag === ""));
});

test("targets: explicit firmware refs keep the pack targets", () => {
  const m = buildMatrix({ fwRefs: ["v3.0.3"], packTargets: ["v3.0.2"], fwBranches: ["development"], packBranches: ["development"] });
  assert.deepEqual(m.include.map((l) => `${l.fw}×${l.pack}`), ["v3.0.3×development", "v3.0.3×v3.0.2"]);
});

test("targets: the shapes `compat targets` may print", () => {
  assert.deepEqual(tagsFrom(["v1.0.0", "x"]), ["v1.0.0"]);
  assert.deepEqual(tagsFrom([{ tag: "dev-v1.0.0" }]), ["dev-v1.0.0"]);
  assert.deepEqual(tagsFrom({ targets: { production: ["v1.0.0"], development: [{ tag: "dev-v1.1.0" }] } }), ["v1.0.0", "dev-v1.1.0"]);
});

test("targets: `compat resolve` (every release) gives every tag, the oldest included", () => {
  // The shape `compat resolve --component S1TTXX` prints, from the real list.
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "releases", "S1TTXX-firmware.json"), "utf8"));
  const resolved = {
    component: "S1TTXX",
    repo: "Tomorrow-Tech-s-r-l/S1TTXX-firmware",
    releases: real.map((r) => ({ tag: r.tagName, version: r.tagName.replace(/^(dev-)?v/, ""), channel: r.tagName.startsWith("dev-") ? "development" : "production" })),
  };
  assert.deepEqual(tagsFrom(resolved).sort(), real.map((r) => r.tagName).sort());
  assert.ok(tagsFrom(resolved).includes("v2.0.0"), "boards older than the harness's first buildable tree are listed too");
  const m = buildMatrix({ fwTargets: tagsFrom(resolved), packTargets: ["v3.0.2", "v2.0.0"], fwBranches: ["development"], packBranches: ["development"] });
  assert.equal(m.include.length, (real.length + 1) * 3);
});

const report = (checks) => ({ checks });

test("evidence: PASS needs every core check to pass", () => {
  const base = { fwTag: "v3.0.3", fwRef: "abc", cliTag: "dev-v0.5.0", cliRef: "def", packTag: "v3.0.2", packRef: "123" };
  const pass = legResult({ ...base, report: report([{ name: "slots", tier: "core", result: "pass" }, { name: "raw", tier: "diag", result: "fail" }]) });
  assert.equal(verdict(pass), "PASS", "a diag failure never moves a floor");
  assert.deepEqual(pass.context, [{ component: "P1TT2C", tag: "v3.0.2", ref: "123" }]);
  const skippedCore = legResult({ ...base, report: report([{ name: "slots", tier: "core", result: "skip" }]) });
  assert.equal(verdict(skippedCore), "FAIL", "a skipped core check is a failure");
  const untiered = legResult({ ...base, report: report([{ name: "slots", result: "fail" }]) });
  assert.equal(untiered.checks[0].tier, "core", "a harness without tiers gates on everything");
  assert.equal(verdict(legResult({ ...base, report: null })), "UNKNOWN");
  assert.equal(legResult({ ...base, report: null }).status, "missing");
  assert.equal(legResult({ ...base, report: null, skipped: "cannot build" }).status, "skipped");
});

test("evidence: one leg is two pairings, split by the edge each check tests", () => {
  // The shape of a real leg (station-cli v0.3.1 x S1TTXX v3.0.3 x P1TT2C
  // dev-v3.1.0): the CLI drops the voltage the pack sends in the INFO_EXT
  // tail. That is the pack's pairing; it must not fail the board's.
  const base = { fwTag: "v3.0.3", fwRef: "abc", cliTag: "v0.3.1", cliRef: "def", packTag: "dev-v3.1.0", packRef: "123" };
  const [board, pack] = legResults({
    ...base,
    report: report([
      { name: "slots", tier: "core", edge: "both", result: "pass" },
      { name: "status empty slot", tier: "core", edge: "board", result: "pass" },
      { name: "status INFO_EXT tail reaches the JSON", tier: "core", edge: "pack", result: "fail" },
    ]),
  });
  assert.deepEqual([board.a.component, board.b.component, verdict(board)], ["S1TTXX", "station_cli", "PASS"]);
  assert.deepEqual(board.checks.map((c) => c.name), ["slots", "status empty slot"]);
  assert.deepEqual([pack.a, pack.context], [
    { component: "P1TT2C", tag: "dev-v3.1.0", ref: "123", sha256: null },
    [{ component: "S1TTXX", tag: "v3.0.3", ref: "abc" }],
  ]);
  assert.equal(verdict(pack), "FAIL");
  assert.equal(legResults({ ...base, report: null })[1].status, "missing");
  // No pack docked: the board pairing only. No edge (an older harness): board.
  assert.equal(legResults({ ...base, packTag: "", packRef: "", report: report([]) }).length, 1);
  assert.equal(legResults({ ...base, report: report([{ name: "slots", tier: "core", result: "fail" }]) })[0].checks.length, 1);
});

test("evidence: two releases tested with a branch build as third component move no floor", () => {
  const checks = report([{ name: "slots", tier: "core", edge: "both", result: "fail" }]);
  // Released firmware and CLI, pack from the P1TT2C development branch: the
  // board pairing would fail S1TTXX v3.0.3 × station-cli v0.5.0 on unreleased
  // pack code, so it is not emitted; the pack side is a branch build anyway.
  const branchPack = legResults({ fwTag: "v3.0.3", fwRef: "abc", cliTag: "v0.5.0", cliRef: "def", packTag: "", packRef: "123", report: checks });
  assert.deepEqual(branchPack.map((r) => [r.a.component, r.a.tag]), [["P1TT2C", null]]);
  // Same the other way round: released pack, firmware branch.
  const branchFw = legResults({ fwTag: "", fwRef: "abc", cliTag: "v0.5.0", cliRef: "def", packTag: "v3.0.2", packRef: "123", report: checks });
  assert.deepEqual(branchFw.map((r) => [r.a.component, r.a.tag]), [["S1TTXX", null]]);
  // A branch build of this CLI: kept (gates CI, release-compatibility-cli drops it).
  assert.equal(legResults({ fwTag: "v3.0.3", fwRef: "abc", cliTag: "", cliRef: "def", packTag: "", packRef: "123", report: checks }).length, 2);
});

test("evidence: a branch side always names a ref, so the file stays valid", () => {
  // The leg died before the firmware commit was read.
  const r = legResult({ fwTag: "", fwRef: "", cliTag: "", cliRef: "", report: null });
  assert.equal(r.a.ref, "unknown");
  assert.equal(r.b.ref, "unknown");
  assert.equal(r.status, "missing");
  // A release needs no ref.
  assert.equal(legResult({ fwTag: "v3.0.3", fwRef: "", cliTag: "v0.5.0", cliRef: "", report: null }).b.ref, null);
});

test("evidence: a branch build has no tag, and the file is compat-evidence/v1", () => {
  const r = legResult({ fwTag: "", fwRef: "abc", cliTag: "", cliRef: "def", report: report([]) });
  assert.equal(r.a.tag, null);
  assert.equal(r.b.tag, null);
  assert.deepEqual(r.context, []);
  const e = merge({ results: [r], suite: "cli_contract", suiteRepo: "o/r", suiteRef: "s", runUrl: "u", now: new Date("2026-10-18T10:00:00.123Z") });
  assert.equal(e.format, "compat-evidence/v1");
  assert.equal(e.generated_at, "2026-10-18T10:00:00Z");
});

// A previous release's metadata.json that was computed (may be carried from).
const computedPrevious = (extra = {}) => ({
  schema: 2,
  component: "station_cli",
  tag: "v0.5.0",
  min_kiosk_app_version: "1.2.0",
  computed: { run_url: "https://github.com/o/r/actions/runs/7", suite_ref: "s", at: "2026-10-01T00:00:00Z", carried_forward: [] },
  ...extra,
});

test("metadata: the kiosk floor from evidence, else carried from a computed value, never a literal", () => {
  const fromEvidence = buildMetadata({
    tag: "dev-v0.6.0",
    version: "0.6.0",
    floor: { requires: { kiosk: { min: "1.3.14", no_compatible: false, tested: ["v1.3.14"] }, S1TTXX: { min: "3.0.3", no_compatible: false, tested: ["v3.0.3"] } } },
    previous: computedPrevious({ min_kiosk_app_version: "1.3.0" }),
  }).meta;
  assert.equal(fromEvidence.schema, 2);
  assert.equal(fromEvidence.channel, "development");
  assert.equal(fromEvidence.cli_version, "0.6.0");
  assert.equal(fromEvidence.min_kiosk_app_version, "1.3.0", "never above what the previous release published without a tested failure");
  assert.deepEqual(fromEvidence.computed.legacy_clamped, { min_kiosk_app_version: { previous: "1.3.0", previous_tag: "v0.5.0", computed: "1.3.14" } });
  assert.equal(fromEvidence.requires.S1TTXX.min, "3.0.3");
  assert.deepEqual(fromEvidence.computed.carried_forward, [], "always present (release-compatibility-cli's metadata schema)");

  const carried = buildMetadata({ tag: "v0.6.0", version: "0.6.0", previous: computedPrevious(), runUrl: "https://github.com/o/r/actions/runs/8" }).meta;
  assert.equal(carried.min_kiosk_app_version, "1.2.0");
  assert.deepEqual(carried.computed.carried_forward, ["min_kiosk_app_version"]);
  assert.deepEqual(carried.computed.carried_from, { min_kiosk_app_version: { tag: "v0.5.0", run_url: "https://github.com/o/r/actions/runs/7" } });

  // Carried again: the origin is the run that computed it, not the carrier.
  const again = buildMetadata({ tag: "v0.7.0", version: "0.7.0", previous: { ...carried, tag: "v0.6.0" } }).meta;
  assert.deepEqual(again.computed.carried_from.min_kiosk_app_version, { tag: "v0.5.0", run_url: "https://github.com/o/r/actions/runs/7" });
});

test("metadata: the kiosk floor `compat metadata --carry-compat` carried into --base is kept", () => {
  // What release-compatibility-cli's `compat metadata --carry-compat` wrote for
  // dev-v0.5.1 from the real computed compatibility.json (sequence 2), with
  // only schema-1 metadata.json behind it.
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "compat", "metadata-carried-dev-v0.5.1.json"), "utf8"));
  const origin = { source: "compatibility.json", sequence: 2, tag: "dev-v0.5.0", evidence: ["https://github.com/Tomorrow-Tech-s-r-l/amperry-kiosk-local/actions/runs/0"] };
  const schema1 = { cli_version: "0.5.0", min_kiosk_app_version: "1.2.0" };
  assert.throws(() => buildMetadata({ tag: "dev-v0.5.1", version: "0.5.1", previous: schema1 }), MetadataError, "without the carry source the release fails");

  const { meta, warnings } = buildMetadata({
    tag: "dev-v0.5.1",
    version: "0.5.1",
    base,
    floor: { requires: { S1TTXX: { min: "3.0.3", no_compatible: false, tested: ["v3.0.3"] } } },
    previous: schema1,
  });
  // Every published station_cli says 1.2.0 and no kiosk >= 1.2.0 failed:
  // the deployed kiosks keep seeing 1.2.0.
  assert.equal(meta.min_kiosk_app_version, "1.2.0");
  assert.deepEqual(meta.computed.legacy_clamped, { min_kiosk_app_version: { previous: "1.2.0", previous_tag: null, computed: "1.3.17" } });
  assert.deepEqual(meta.computed.carried_forward, ["min_kiosk_app_version"]);
  assert.deepEqual(meta.computed.carried_from, { min_kiosk_app_version: origin });
  assert.equal(meta.requires.S1TTXX.min, "3.0.3");
  assert.match(warnings[0], /carried forward from dev-v0\.5\.0 \(compatibility\.json sequence 2/);
  // With nothing published before it, the carried floor stands.
  assert.equal(buildMetadata({ tag: "dev-v0.5.1", version: "0.5.1", base, previous: null }).meta.min_kiosk_app_version, "1.3.17");

  // The next release may carry it on through this metadata.json; the origin stays the entry.
  const next = buildMetadata({ tag: "dev-v0.5.2", version: "0.5.2", previous: meta }).meta;
  assert.equal(next.min_kiosk_app_version, "1.2.0");
  assert.deepEqual(next.computed.carried_from, { min_kiosk_app_version: origin });
  // An entry that names no evidence is no provenance.
  const bare = { ...meta, computed: { ...meta.computed, carried_from: { min_kiosk_app_version: { ...origin, evidence: [] } } } };
  assert.throws(() => buildMetadata({ tag: "dev-v0.5.2", version: "0.5.2", base: bare, previous: bare }), /no computed provenance/);
  // Evidence of this run wins over the carried value.
  const own = buildMetadata({ tag: "dev-v0.5.1", version: "0.5.1", base, floor: { requires: { kiosk: { min: "1.4.0", no_compatible: false, tested: ["v1.4.0"] } } } }).meta;
  assert.equal(own.min_kiosk_app_version, "1.4.0");
  assert.deepEqual(own.computed.carried_forward, []);
  assert.equal(own.computed.carried_from, undefined);
});

test("metadata: no evidence and no computed previous value fails the release", () => {
  assert.throws(() => buildMetadata({ tag: "v0.6.0", version: "0.6.0" }), (e) => e instanceof MetadataError && /no previous computed value/.test(e.message));
  // A schema-1 file, or a value with no run behind it, has no provenance.
  for (const previous of [
    { min_kiosk_app_version: "1.2.0" },
    computedPrevious({ computed: { run_url: null, carried_forward: [] } }),
    computedPrevious({ computed: { run_url: "u", carried_forward: ["min_kiosk_app_version"] } }),
    computedPrevious({ computed: { run_url: "u", carried_forward: [], uncomputed: ["min_kiosk_app_version"] } }),
  ]) {
    assert.throws(() => buildMetadata({ tag: "v0.6.0", version: "0.6.0", previous }), /no computed provenance/);
  }
  assert.throws(() => buildMetadata({ tag: "nightly", version: "0.6.0" }), /not a station_cli release tag/);
});

test("metadata: this run's floor wins over the published file, legacy values are X.Y.Z", () => {
  const base = {
    schema: 2,
    component: "station_cli",
    tag: "dev-v0.6.0",
    requires: {
      S1TTXX: { min: "3.0.1", no_compatible: false, tested: ["v3.0.1"] },
      kiosk: { min: "1.4.0-dev.23", min_tag: "v1.4.0-dev.23", no_compatible: false, tested: ["v1.4.0-dev.23"] },
    },
    computed: { run_url: null, carried_forward: [], uncomputed: ["min_kiosk_app_version"] },
  };
  const { meta } = buildMetadata({
    tag: "dev-v0.6.0",
    version: "0.6.0",
    base,
    floor: { requires: { S1TTXX: { min: "3.0.3", no_compatible: false, tested: ["v3.0.3"] } } },
  });
  assert.equal(meta.requires.S1TTXX.min, "3.0.3", "the evidence of this run, not the stale published entry");
  assert.equal(meta.requires.kiosk.min_tag, "v1.4.0-dev.23", "what the run did not test comes from the file");
  assert.equal(meta.min_kiosk_app_version, "1.4.0", "legacy kiosks parse X.Y.Z only");
  assert.equal(meta.computed.uncomputed, undefined);
  assert.deepEqual(meta.computed.carried_forward, []);
});

test("metadata: the legacy floor is the one of the release's own channel", () => {
  // Over both channels the newest kiosk (a dev build) fails; over production
  // kiosks v1.3.17 is the floor.
  const kiosk = {
    min: null, min_tag: null, no_compatible: true, tested: ["v1.3.17", "v1.4.0-dev.23"], failed: ["v1.4.0-dev.23"],
    channels: {
      production: { min: "1.3.17", min_tag: "v1.3.17", no_compatible: false, tested: ["v1.3.17"], failed: [] },
      development: { min: null, min_tag: null, no_compatible: true, tested: ["v1.3.17", "v1.4.0-dev.23"], failed: ["v1.4.0-dev.23"] },
    },
  };
  const prod = buildMetadata({ tag: "v0.6.0", version: "0.6.0", base: { requires: { kiosk } } }).meta;
  assert.equal(prod.channel, "production");
  assert.equal(prod.min_kiosk_app_version, "1.3.17");
  assert.equal(prod.computed.legacy_blocked, undefined);
  const dev = buildMetadata({ tag: "dev-v0.6.0", version: "0.6.0", base: { requires: { kiosk } } }).meta;
  assert.equal(dev.min_kiosk_app_version, "1.4.1");
  assert.deepEqual(dev.computed.legacy_blocked, ["min_kiosk_app_version"]);

  // Nothing of the release's channel was tested: no evidence, so carried.
  const untested = { ...kiosk, channels: { ...kiosk.channels, production: { min: null, min_tag: null, no_compatible: true, reason: "untested", tested: [], failed: [] } } };
  const carried = buildMetadata({ tag: "v0.6.0", version: "0.6.0", base: { requires: { kiosk: untested } }, previous: computedPrevious() }).meta;
  assert.equal(carried.min_kiosk_app_version, "1.2.0");
  assert.deepEqual(carried.computed.carried_forward, ["min_kiosk_app_version"]);
});

test("metadata: no compatible kiosk is never read as no floor by an old kiosk", () => {
  const { meta } = buildMetadata({
    tag: "v0.6.0",
    version: "0.6.0",
    base: { requires: { kiosk: { min: null, no_compatible: true, tested: ["v1.3.17", "v1.4.0-dev.23"], failed: ["v1.4.0-dev.23"] } } },
    previous: computedPrevious(),
  });
  // Above the published 1.2.0, proven by the tested failure of 1.4.0-dev.23.
  assert.equal(meta.min_kiosk_app_version, "1.4.1");
  assert.deepEqual(meta.computed.legacy_blocked, ["min_kiosk_app_version"]);
  assert.deepEqual(meta.computed.carried_forward, []);
  assert.deepEqual(meta.computed.legacy_raised, {
    min_kiosk_app_version: { previous: "1.2.0", previous_tag: "v0.5.0", value: "1.4.1", failed: ["v1.4.0-dev.23"] },
  });
});

test("metadata: deployed kiosks never get a higher floor without a tested failure at or above the published one", () => {
  const pub = (v) => ({ tag: "v0.3.1", metadata: { cli_version: "0.3.1", min_kiosk_app_version: v } });
  // Lower or equal: always fine.
  assert.deepEqual(clampToPublished("1.0.0", "min_kiosk_app_version", [], pub("1.2.0")), { value: "1.0.0" });
  assert.deepEqual(clampToPublished("1.2.0", "min_kiosk_app_version", [], pub("1.2.0")), { value: "1.2.0" });
  // Higher, only untested or older failures: kept at the published value.
  assert.deepEqual(clampToPublished("1.3.17", "min_kiosk_app_version", ["v1.1.0"], pub("1.2.0")), {
    value: "1.2.0",
    clamped: { previous: "1.2.0", previous_tag: "v0.3.1", computed: "1.3.17" },
  });
  // A failure at or above the published value proves the raise.
  assert.deepEqual(clampToPublished("1.3.17", "min_kiosk_app_version", ["v1.1.0", "v1.2.10", "v1.3.0-dev.4"], pub("1.2.0")).raised, {
    previous: "1.2.0",
    previous_tag: "v0.3.1",
    value: "1.3.17",
    failed: ["v1.2.10", "v1.3.0-dev.4"],
  });
  // Nothing published, or an unreadable value: nothing to protect.
  assert.deepEqual(clampToPublished("1.3.17", "min_kiosk_app_version", [], null), { value: "1.3.17" });
  assert.deepEqual(clampToPublished("1.3.17", "min_kiosk_app_version", [], pub("latest")), { value: "1.3.17" });
});

test("metadata: --published (what kiosks saw last, any schema) is what the floor is held to", () => {
  // The previous COMPUTED release says 1.0.0; the newest published one (schema 1) 1.2.0.
  const floor = { requires: { kiosk: { min: "1.3.17", no_compatible: false, tested: ["v1.3.17"], failed: [] } } };
  const held = buildMetadata({
    tag: "v0.6.0", version: "0.6.0", floor,
    previous: computedPrevious({ min_kiosk_app_version: "1.0.0" }),
    published: { tag: "v0.5.1", metadata: { cli_version: "0.5.1", min_kiosk_app_version: "1.2.0" } },
  }).meta;
  assert.equal(held.min_kiosk_app_version, "1.2.0");
  assert.equal(held.computed.legacy_clamped.min_kiosk_app_version.previous_tag, "v0.5.1");
  const lines = legacyReport(held);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "notice");

  // A raise is loud.
  const raisedFloor = { requires: { kiosk: { min: "1.3.17", no_compatible: false, tested: ["v1.2.10", "v1.3.17"], failed: ["v1.2.10"] } } };
  const raised = buildMetadata({ tag: "v0.6.0", version: "0.6.0", floor: raisedFloor, published: { tag: "v0.5.1", metadata: { min_kiosk_app_version: "1.2.0" } } }).meta;
  assert.equal(raised.min_kiosk_app_version, "1.3.17");
  const [warning] = legacyReport(raised);
  assert.equal(warning.level, "warning");
  assert.match(warning.text, /1\.2\.0 \(v0\.5\.1\) -> 1\.3\.17; deployed kiosks below it will refuse this CLI\. Proven by tested failures: v1\.2\.10/);
});

test("metadata: the previous releases are found by grammar and precedence", () => {
  const tags = ["dev-v0.5.0", "dev-v0.4.1", "v0.3.1", "dev-v0.3.1", "v0.2.4", "nightly"];
  assert.equal(previousTag(tags, "dev-v0.6.0"), "dev-v0.5.0");
  assert.equal(previousTag(tags, "v0.6.0"), "v0.3.1", "same channel first");
  assert.equal(previousTag(tags, "v0.3.1"), "v0.2.4");
  assert.equal(previousTag(["dev-v0.1.0"], "v0.2.0"), "dev-v0.1.0", "else any lower release");
  assert.equal(previousTag(tags, "v0.0.1"), null);
  assert.deepEqual(previousTags(tags, "v0.6.0"), ["v0.3.1", "v0.2.4", "dev-v0.5.0", "dev-v0.4.1", "dev-v0.3.1"]);
  assert.equal(hasProvenance(computedPrevious()), true);
  assert.equal(hasProvenance({ min_kiosk_app_version: "1.2.0" }), false);
  assert.equal(hasProvenance(null), false);
});

// --- the gate --------------------------------------------------------------

const { gate, legVerdicts } = require("../../scripts/contract-evidence");

test("gate: a failing development pack is a fact for the floors, not a red run", () => {
  // The 2026-10-18 shape: every CLI >= v0.3.1 drops the voltage dev-v3.1.0
  // sends; with the production pack v3.0.2 it passes.
  const leg = (fwTag, packTag, packResult) =>
    legVerdicts({
      fwTag, fwRef: "f", cliTag: "v0.5.0", cliRef: "c", packTag, packRef: "p",
      report: report([
        { name: "slots", tier: "core", edge: "both", result: "pass" },
        { name: "tail", tier: "core", edge: "pack", result: packResult },
      ]),
    });
  const legs = [leg("v3.0.3", "v3.0.2", "pass"), leg("v3.0.3", "dev-v3.1.0", "fail"), leg("dev-v3.2.0", "dev-v3.1.0", "fail")];
  assert.deepEqual(gate({ legs }), []);
  // …but failing the production pack in the production board is red.
  const red = gate({ legs: [leg("v3.0.3", "v3.0.2", "fail"), leg("v3.0.1", "v3.0.2", "pass")] });
  assert.equal(red.length, 1);
  assert.match(red[0], /P1TT2C v3\.0\.2, the newest production pack firmware tested \(in S1TTXX v3\.0\.3\)/);
});

test("gate: red on a dead leg, on nothing run, and on the newest production board", () => {
  assert.match(gate({ legs: [] })[0], /did not run/);
  assert.deepEqual(gate({ legs: [], skipped: ["RELEASE_TOKEN not set"] }), [], "a run that could not test anything is not red");
  assert.match(gate({ legs: [], missing: ["fw v3.0.3 × pack v3.0.2"] })[0], /failed before the checks ran/);
  const board = (fwTag, result) =>
    legVerdicts({ fwTag, fwRef: "f", cliTag: "", cliRef: "c", report: report([{ name: "status empty slot", tier: "core", edge: "board", result }]) });
  assert.match(gate({ legs: [board("v3.0.3", "fail"), board("dev-v3.2.0", "pass")] })[0], /S1TTXX v3\.0\.3, the newest production firmware/);
  assert.deepEqual(gate({ legs: [board("v3.0.3", "pass"), board("v3.0.1", "fail")] }), [], "an older release: a floor");
  const notes = [];
  assert.deepEqual(gate({ legs: [board("", "fail")], notes }), [], "branches only: nothing to say about stations");
  assert.match(notes[0], /no production S1TTXX release was tested/);
});
