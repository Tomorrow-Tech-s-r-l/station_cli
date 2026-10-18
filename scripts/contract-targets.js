#!/usr/bin/env node
/**
 * Builds the firmware_contract.yml matrix: station firmware (S1TTXX) ×
 * powerbank firmware (P1TT2C) legs for THIS station-cli.
 *
 *   node scripts/contract-targets.js \
 *     [--fw-targets <file>]   output of `compat targets --component S1TTXX`
 *     [--pack-targets <file>] output of `compat targets --component P1TT2C`
 *     [--fw-branches development,main] [--pack-branches development]
 *     [--fw-refs '<json list>']  explicit refs (dispatch input); overrides --fw-targets
 *
 * Prints {"include": [...]} for `strategy.matrix` (and the legs, readably,
 * on stderr). Each leg:
 *   {fw, fw_ref, fw_tag, pack, pack_ref, pack_tag}
 * `fw_tag` / `pack_tag` are set only for releases: a branch build is tested
 * (it gates CI) but never produces a compatibility floor.
 *
 * Which releases are tested is release-compat's decision (`compat targets`:
 * the newest per channel, plus whatever the floors depend on), not a version
 * written here. Without release-compat (no COMPAT_TOKEN) the legacy
 * selectors `release` / `dev-release` are passed through, resolved per leg
 * by the harness's release.js, and the pack axis is the harness's own.
 *
 * Dependency-free on purpose: it runs before `npm ci`.
 */

"use strict";

const fs = require("node:fs");

const FW_TAG = /^(v|dev-v)\d+\.\d+\.\d+$/;

/**
 * Reads the tags out of a `compat targets` result. Accepts the shapes that
 * command may print: a list of tags, a list of {tag}, or an object holding
 * either under `targets` or per channel.
 */
function tagsFrom(doc) {
  const out = [];
  const visit = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      if (typeof v.tag === "string") out.push(v.tag);
      else if (v.targets !== undefined) visit(v.targets);
      else Object.values(v).forEach(visit);
    }
  };
  visit(doc);
  return [...new Set(out.filter((t) => FW_TAG.test(t)))];
}

function readTargets(file) {
  if (!file) return null;
  return tagsFrom(JSON.parse(fs.readFileSync(file, "utf8")));
}

function list(spec) {
  return (spec || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One axis entry from a ref or tag. */
function entry(ref) {
  if (FW_TAG.test(ref)) return { label: ref, ref, tag: ref };
  return { label: ref, ref, tag: null }; // a branch, or a legacy selector resolved in the leg
}

function buildMatrix(opts) {
  let fw;
  if (opts.fwRefs && opts.fwRefs.length) {
    fw = opts.fwRefs.map(entry);
  } else if (opts.fwTargets) {
    fw = [...opts.fwBranches, ...opts.fwTargets].map(entry);
  } else {
    fw = [...opts.fwBranches, "release", "dev-release"].map(entry);
  }
  // No pack axis without release-compat: the harness uses its own pack.
  const packs = opts.packTargets
    ? [...opts.packBranches, ...opts.packTargets].map(entry)
    : [{ label: "harness", ref: "", tag: null }];

  const seen = new Set();
  const include = [];
  for (const f of fw) {
    for (const p of packs) {
      const key = `${f.ref}|${p.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      include.push({
        fw: f.label,
        fw_ref: f.ref,
        fw_tag: f.tag ?? "",
        pack: p.label,
        pack_ref: p.ref,
        pack_tag: p.tag ?? "",
      });
    }
  }
  return { include };
}

module.exports = { tagsFrom, buildMatrix };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  let fwRefs = null;
  const rawRefs = opt("--fw-refs");
  if (rawRefs && rawRefs.trim()) {
    fwRefs = JSON.parse(rawRefs);
    if (!Array.isArray(fwRefs) || !fwRefs.every((r) => typeof r === "string")) {
      console.error("--fw-refs must be a JSON list of strings");
      process.exit(2);
    }
  }
  const matrix = buildMatrix({
    fwRefs,
    fwTargets: readTargets(opt("--fw-targets")),
    packTargets: readTargets(opt("--pack-targets")),
    fwBranches: list(opt("--fw-branches") ?? "development,main"),
    packBranches: list(opt("--pack-branches") ?? "development"),
  });
  for (const l of matrix.include) console.error(`leg: fw ${l.fw} × pack ${l.pack}`);
  process.stdout.write(JSON.stringify(matrix) + "\n");
}
