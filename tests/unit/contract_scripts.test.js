// The CI helper scripts of firmware_contract.yml and build.yml: the test
// matrix, the evidence a leg emits, and the release metadata.json (schema 2).
// Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildMatrix, tagsFrom } = require("../../scripts/contract-targets");
const { legResult, legResults, verdict, merge } = require("../../scripts/contract-evidence");
const { buildMetadata, previousTag } = require("../../scripts/release-metadata");

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

test("targets: without release-compat the legacy selectors and the harness pack", () => {
  const m = buildMatrix({ fwBranches: ["development", "main"], packBranches: ["development"] });
  assert.deepEqual(m.include.map((l) => l.fw), ["development", "main", "release", "dev-release"]);
  assert.ok(m.include.every((l) => l.pack === "harness" && l.pack_ref === ""));
});

test("targets: the shapes `compat targets` may print", () => {
  assert.deepEqual(tagsFrom(["v1.0.0", "x"]), ["v1.0.0"]);
  assert.deepEqual(tagsFrom([{ tag: "dev-v1.0.0" }]), ["dev-v1.0.0"]);
  assert.deepEqual(tagsFrom({ targets: { production: ["v1.0.0"], development: [{ tag: "dev-v1.1.0" }] } }), ["v1.0.0", "dev-v1.1.0"]);
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

test("evidence: a branch build has no tag, and the file is compat-evidence/v1", () => {
  const r = legResult({ fwTag: "", fwRef: "abc", cliTag: "", cliRef: "def", report: report([]) });
  assert.equal(r.a.tag, null);
  assert.equal(r.b.tag, null);
  assert.deepEqual(r.context, []);
  const e = merge({ results: [r], suite: "cli_contract", suiteRepo: "o/r", suiteRef: "s", runUrl: "u", now: new Date("2026-10-18T10:00:00.123Z") });
  assert.equal(e.format, "compat-evidence/v1");
  assert.equal(e.generated_at, "2026-10-18T10:00:00Z");
});

test("metadata: the kiosk floor from evidence, else carried forward, never a literal", () => {
  const fromEvidence = buildMetadata({
    tag: "dev-v0.6.0",
    version: "0.6.0",
    floor: { requires: { kiosk: { min: "1.3.14", no_compatible: false }, S1TTXX: { min: "3.0.3", no_compatible: false } } },
    previous: { min_kiosk_app_version: "1.2.0" },
  }).meta;
  assert.equal(fromEvidence.schema, 2);
  assert.equal(fromEvidence.cli_version, "0.6.0");
  assert.equal(fromEvidence.min_kiosk_app_version, "1.3.14");
  assert.equal(fromEvidence.requires.S1TTXX.min, "3.0.3");
  assert.equal(fromEvidence.computed.carried_forward, undefined);

  const carried = buildMetadata({ tag: "v0.6.0", version: "0.6.0", previous: { min_kiosk_app_version: "1.2.0" } }).meta;
  assert.equal(carried.min_kiosk_app_version, "1.2.0");
  assert.deepEqual(carried.computed.carried_forward, ["min_kiosk_app_version"]);

  const none = buildMetadata({ tag: "v0.6.0", version: "0.6.0" });
  assert.equal(none.meta.min_kiosk_app_version, undefined);
  assert.match(none.warnings[0], /left out/);
});

test("metadata: the previous release is found by grammar and precedence", () => {
  const tags = ["dev-v0.5.0", "dev-v0.4.1", "v0.3.1", "dev-v0.3.1", "v0.2.4", "nightly"];
  assert.equal(previousTag(tags, "dev-v0.6.0"), "dev-v0.5.0");
  assert.equal(previousTag(tags, "v0.6.0"), "v0.3.1", "same channel first");
  assert.equal(previousTag(tags, "v0.3.1"), "v0.2.4");
  assert.equal(previousTag(["dev-v0.1.0"], "v0.2.0"), "dev-v0.1.0", "else any lower release");
  assert.equal(previousTag(tags, "v0.0.1"), null);
});
