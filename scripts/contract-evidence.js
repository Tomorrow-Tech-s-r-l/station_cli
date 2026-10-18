#!/usr/bin/env node
/**
 * Turns firmware-contract leg reports into `compat-evidence/v1`, the format
 * release-compat computes floors from.
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
 *     A result.json holds one result, or a list of two.
 *
 *   node scripts/contract-evidence.js merge --dir <results dir> --out <evidence.json>
 *       --suite cli_contract --suite-repo <owner/name> --suite-ref <sha> --run-url <url>
 *
 * A side that is a branch build has `tag: null`: such a result gates CI but
 * never moves a floor. Check tiers come from the harness report (`tier` per
 * check); a harness from before tiers had every check gate the pair, so a
 * missing tier is read as `core`.
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
function legResult({ report, skipped, fwTag, fwRef, cliTag, cliRef, cliFile, packTag, packRef }) {
  const status = skipped ? "skipped" : report ? "ok" : "missing";
  const result = {
    a: { component: "S1TTXX", tag: orNull(fwTag), ref: orNull(fwRef), sha256: null },
    b: { component: "station_cli", tag: orNull(cliTag), ref: orNull(cliRef), sha256: sha256(cliFile) },
    context: orNull(packTag) || orNull(packRef) ? [{ component: "P1TT2C", tag: orNull(packTag), ref: orNull(packRef) }] : [],
    status,
    checks: report ? checksFrom(report) : [],
  };
  if (skipped) result.detail = String(skipped);
  return result;
}

/**
 * Every result one leg is evidence for: [S1TTXX × station_cli] and, when a
 * pack was docked, [P1TT2C × station_cli]. Checks are split by edge.
 */
function legResults(leg) {
  const board = legResult(leg);
  if (leg.report) board.checks = checksFrom(leg.report, "board");
  const [pack] = board.context;
  if (!pack) return [board];
  const packResult = {
    ...board,
    a: { ...pack, sha256: null },
    context: [{ component: "S1TTXX", tag: board.a.tag, ref: board.a.ref }],
    checks: leg.report ? checksFrom(leg.report, "pack") : [],
  };
  return [board, packResult];
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

module.exports = { legResult, legResults, verdict, merge, checksFrom };

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
    write(opt("--out"), results.length === 1 ? results[0] : results);
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
  } else {
    console.error("usage: contract-evidence.js leg|merge … (see the header of this file)");
    process.exit(2);
  }
}
