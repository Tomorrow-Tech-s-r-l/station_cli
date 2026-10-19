#!/usr/bin/env node
/**
 * Turns firmware-contract leg reports into `compat-evidence/v1`, the format
 * release-compatibility-cli computes floors from.
 *
 *   node scripts/contract-evidence.js leg --out <result.json>
 *       [--report <leg.json>] [--skipped <reason>]
 *       --fw-tag <tag|""> --fw-ref <sha> --cli-tag <tag|""> --cli-ref <sha> [--cli-file <executable>]
 *       [--pack-tag <tag|""> --pack-ref <sha|"">]
 *     The S1TTXX × station_cli pair of one leg, with the P1TT2C build the
 *     simulated station ran as context — and, when a pack was docked, the
 *     P1TT2C × station_cli pair with the firmware as context. The harness
 *     tags each check with the `edge` it tests (board, pack or both): a
 *     pack-only failure (what the CLI makes of the pack's data) never moves
 *     the board's floor, as in S1TTXX-firmware's own cli_contract evidence.
 *     A result.json holds the list of those results (zero to two).
 *
 *     Beside it, verdicts.json: this leg's tags and its board / pack verdicts
 *     over all of its checks, for the gate.
 *
 *   node scripts/contract-evidence.js merge --dir <results dir> --out <evidence.json>
 *       --suite cli_contract --suite-repo <owner/name> --suite-ref <sha> --run-url <url>
 *
 *   node scripts/contract-evidence.js gate --dir <results dir> [--out <gate.txt>]
 *     Why the run must go red, one reason per line (none: green). A failing
 *     pair is a fact for the floors, not a broken build — as in
 *     S1TTXX-firmware's cli_contract — except against what stations run:
 *     red when a leg died before its checks, when no leg reported at all, or
 *     when this CLI fails a core check against the newest production S1TTXX
 *     release tested (board pairing) or, docked in it, the newest production
 *     P1TT2C release tested (pack pairing).
 *
 * A side that is a branch build has `tag: null`: such a result gates CI but
 * never moves a floor. It always carries a `ref` (the commit, else the branch
 * the leg named): release-compatibility-cli rejects a whole evidence file over one side
 * that has neither. A pairing of two releases tested with a branch build as
 * the third component is not emitted at all — its verdict would move a
 * release floor on unreleased code (the harness table still reports it).
 * Check tiers come from the harness report (`tier` per check); a harness
 * from before tiers had every check gate the pair, so a missing tier is read
 * as `core`.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TIERS = new Set(["core", "feature", "diag"]);
const RESULTS = new Set(["pass", "fail", "skip"]);

const orNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function sha256(file) {
  if (!file) return null;
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

const EDGES = { board: new Set(["board", "both"]), pack: new Set(["pack", "both"]) };

/**
 * Checks of one harness report, normalised to the evidence shape. With
 * `edge`, only the checks of that pairing; a check without an edge (a harness
 * from before edges) belongs to the board pairing.
 */
function checksFrom(report, edge) {
  return (report.checks || [])
    .filter((c) => !edge || EDGES[edge].has(c.edge ?? "board"))
    .map((c) => ({
    name: String(c.name),
    tier: TIERS.has(c.tier) ? c.tier : "core",
    result: RESULTS.has(c.result) ? c.result : "fail",
    detail: c.detail == null ? "" : String(c.detail),
    }));
}

/**
 * One evidence result. `report` is the parsed leg.json, or null when the leg
 * produced none (`missing`), or `skipped` says why it was not run.
 */
/** A side's `ref`: a branch build (no tag) always names one, "unknown" at worst. */
const refOf = (tag, ref) => orNull(ref) ?? (orNull(tag) ? null : "unknown");

function legResult({ report, skipped, fwTag, fwRef, cliTag, cliRef, cliFile, packTag, packRef }) {
  const status = skipped ? "skipped" : report ? "ok" : "missing";
  const result = {
    a: { component: "S1TTXX", tag: orNull(fwTag), ref: refOf(fwTag, fwRef), sha256: null },
    b: { component: "station_cli", tag: orNull(cliTag), ref: refOf(cliTag, cliRef), sha256: sha256(cliFile) },
    context: orNull(packTag) || orNull(packRef) ? [{ component: "P1TT2C", tag: orNull(packTag), ref: orNull(packRef) }] : [],
    status,
    checks: report ? checksFrom(report) : [],
  };
  if (skipped) result.detail = String(skipped);
  return result;
}

/**
 * Every result one leg is evidence for: [S1TTXX × station_cli] and, when a
 * pack was docked, [P1TT2C × station_cli]. Checks are split by edge. A
 * release × release pairing whose third component is a branch build is left
 * out (see the header).
 */
function legResults(leg) {
  const board = legResult(leg);
  if (leg.report) board.checks = checksFrom(leg.report, "board");
  const [pack] = board.context;
  if (!pack) return [board];
  if (!pack.ref) pack.ref = refOf(pack.tag, null);
  const packResult = {
    ...board,
    a: { ...pack, sha256: null },
    context: [{ component: "S1TTXX", tag: board.a.tag, ref: board.a.ref }],
    checks: leg.report ? checksFrom(leg.report, "pack") : [],
  };
  const floorsOnBranch = (r) => r.a.tag !== null && r.b.tag !== null && r.context.some((c) => c.tag === null);
  return [board, packResult].filter((r) => !floorsOnBranch(r));
}

/** PASS iff ok and every core check passed (a skipped core check fails). */
function verdict(result) {
  if (result.status !== "ok") return "UNKNOWN";
  return result.checks.every((c) => c.tier !== "core" || c.result === "pass") ? "PASS" : "FAIL";
}

function merge({ results, suite, suiteRepo, suiteRef, runUrl, now = new Date() }) {
  return {
    format: "compat-evidence/v1",
    suite,
    suite_repo: suiteRepo,
    suite_ref: suiteRef,
    run_url: runUrl,
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    results,
  };
}

/** This leg for the gate: tags, status and the verdict of each pairing over all its checks. */
function legVerdicts(leg) {
  const board = legResult(leg);
  const v = (edge) => (leg.report ? verdict({ status: board.status, checks: checksFrom(leg.report, edge) }) : "UNKNOWN");
  return {
    fw: board.a.tag,
    pack: board.context[0]?.tag ?? null,
    status: board.status,
    board: v("board"),
    pack_verdict: board.context.length ? v("pack") : null,
  };
}

const PROD = /^v(\d+)\.(\d+)\.(\d+)$/;
const newestProd = (tags) =>
  tags
    .filter((t) => t && PROD.test(t))
    .map((t) => ({ t, n: PROD.exec(t).slice(1).map(Number) }))
    .sort((a, b) => b.n[0] - a.n[0] || b.n[1] - a.n[1] || b.n[2] - a.n[2])[0]?.t ?? null;

/**
 * The gate (see the header). `legs`: every leg's verdicts.json; `missing`
 * and `skipped`: the labels of legs that died / were not run.
 */
function gate({ legs, missing = [], skipped = [], notes = [] }) {
  const reasons = [];
  if (!legs.length && !missing.length && !skipped.length) reasons.push("no leg reported: the contract matrix did not run");
  for (const m of missing) reasons.push(`${m}: the leg failed before the checks ran`);
  const ran = legs.filter((l) => l.status === "ok");
  const fw = newestProd(ran.map((l) => l.fw));
  if (fw) {
    const pack = newestProd(ran.filter((l) => l.fw === fw).map((l) => l.pack));
    const prod = ran.filter((l) => l.fw === fw && (!pack || l.pack === pack));
    if (prod.some((l) => l.board !== "PASS")) {
      reasons.push(`this station-cli fails a core check against S1TTXX ${fw}, the newest production firmware tested${pack ? ` (pack ${pack})` : ""}`);
    }
    if (pack && prod.some((l) => l.pack_verdict !== "PASS")) {
      reasons.push(`this station-cli fails a core check against P1TT2C ${pack}, the newest production pack firmware tested (in S1TTXX ${fw})`);
    }
  } else if (ran.length) {
    // e.g. a dispatch with branches only: nothing to say about stations.
    notes.push("no production S1TTXX release was tested against this station-cli");
  }
  return reasons;
}

module.exports = { legResult, legResults, legVerdicts, verdict, merge, gate, checksFrom };

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const write = (file, doc) => {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  };

  if (cmd === "leg") {
    const reportFile = opt("--report");
    let report = null;
    if (reportFile && fs.existsSync(reportFile)) report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    const results = legResults({
      report,
      skipped: opt("--skipped"),
      fwTag: opt("--fw-tag"),
      fwRef: opt("--fw-ref"),
      cliTag: opt("--cli-tag"),
      cliRef: opt("--cli-ref"),
      cliFile: opt("--cli-file"),
      packTag: opt("--pack-tag"),
      packRef: opt("--pack-ref"),
    });
    write(opt("--out"), results);
    const leg = {
      report,
      skipped: opt("--skipped"),
      fwTag: opt("--fw-tag"),
      fwRef: opt("--fw-ref"),
      cliTag: opt("--cli-tag"),
      cliRef: opt("--cli-ref"),
      packTag: opt("--pack-tag"),
      packRef: opt("--pack-ref"),
    };
    write(path.join(path.dirname(path.resolve(opt("--out"))), "verdicts.json"), legVerdicts(leg));
    for (const r of results) {
      console.log(`evidence: ${r.a.component} ${r.a.tag ?? r.a.ref} × station-cli ${r.b.tag ?? r.b.ref}: ${verdict(r)}`);
    }
  } else if (cmd === "merge") {
    const dir = opt("--dir");
    const files = [];
    const walk = (d) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "result.json") files.push(p);
      }
    };
    walk(dir);
    const results = files.sort().flatMap((f) => [JSON.parse(fs.readFileSync(f, "utf8"))].flat());
    write(
      opt("--out"),
      merge({
        results,
        suite: opt("--suite") || "cli_contract",
        suiteRepo: opt("--suite-repo"),
        suiteRef: opt("--suite-ref"),
        runUrl: opt("--run-url"),
      })
    );
    console.log(`evidence: ${results.length} result(s) → ${opt("--out")}`);
  } else if (cmd === "gate") {
    const legs = [];
    const missing = [];
    const skipped = [];
    const walk = (d) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "verdicts.json") legs.push(JSON.parse(fs.readFileSync(p, "utf8")));
        else if (e.name === "leg.missing") missing.push(fs.readFileSync(p, "utf8").trim());
        else if (e.name === "leg.skipped") skipped.push(fs.readFileSync(p, "utf8").trim());
      }
    };
    walk(opt("--dir"));
    const notes = [];
    const reasons = gate({ legs, missing, skipped, notes });
    for (const n of notes) console.log(`::notice::firmware contract: ${n}`);
    if (opt("--out")) fs.writeFileSync(opt("--out"), reasons.map((r) => `${r}\n`).join(""));
    for (const r of reasons) console.log(`gate: ${r}`);
    if (!reasons.length) console.log(`gate: green (${legs.length} leg(s) reported, ${skipped.length} not run)`);
  } else {
    console.error("usage: contract-evidence.js leg|merge|gate … (see the header of this file)");
    process.exit(2);
  }
}
