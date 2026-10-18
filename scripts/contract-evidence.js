#!/usr/bin/env node
/**
 * Turns firmware-contract leg reports into `compat-evidence/v1`, the format
 * release-compat computes floors from.
 *
 *   node scripts/contract-evidence.js leg --out <result.json>
 *       [--report <leg.json>] [--skipped <reason>]
 *       --fw-tag <tag|""> --fw-ref <sha> --cli-tag <tag|""> --cli-ref <sha> [--cli-file <executable>]
 *       [--pack-tag <tag|""> --pack-ref <sha|"">]
 *     One result: the S1TTXX × station_cli pair of one leg, with the P1TT2C
 *     build the simulated station ran as context.
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

/** Checks of one harness report, normalised to the evidence shape. */
function checksFrom(report) {
  return (report.checks || []).map((c) => ({
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

module.exports = { legResult, verdict, merge, checksFrom };

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
    const result = legResult({
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
    write(opt("--out"), result);
    console.log(`evidence: S1TTXX ${result.a.tag ?? result.a.ref} × station-cli ${result.b.tag ?? result.b.ref}: ${verdict(result)}`);
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
    const results = files.sort().map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
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
