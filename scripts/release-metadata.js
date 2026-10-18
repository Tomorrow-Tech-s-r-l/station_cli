#!/usr/bin/env node
/**
 * Completes this release's metadata.json (schema 2) in the release job.
 *
 *   node scripts/release-metadata.js --tag <tag> --version <X.Y.Z> --out metadata.json
 *       [--base <file>]          what `compat metadata` wrote (release-compat), if it ran
 *       [--floor <file>]         what `compat floor` printed for this tag, if it ran
 *       [--previous <file>]      the previous release's published metadata.json, if any
 *       [--capabilities <file>]  `station-cli capabilities --json` of the binary released
 *       [--run-url <url>] [--suite-ref <sha>]
 *
 *   node scripts/release-metadata.js previous-tag <tag> < tags.txt
 *     prints the release whose metadata.json legacy values carry forward.
 *
 * Nothing here is a floor written by hand. The values come from, in order:
 *   - the contract evidence of this run (`--base` / `--floor`, computed by
 *     release-compat);
 *   - for a legacy field the evidence does not cover, the previous release's
 *     published value, carried forward and listed in
 *     `computed.carried_forward`, so older kiosks keep working;
 *   - otherwise the field is left out and a warning says so — never a literal.
 *
 * Legacy keys (read by kiosks already in the field): `cli_version`,
 * `min_kiosk_app_version`.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LEGACY = { min_kiosk_app_version: "kiosk" };

function readJson(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The `requires` map out of a `compat floor` result, whatever its envelope. */
function requiresFrom(floor) {
  if (!floor || typeof floor !== "object") return {};
  if (floor.requires && typeof floor.requires === "object") return floor.requires;
  const out = {};
  for (const [k, v] of Object.entries(floor)) {
    if (v && typeof v === "object" && ("min" in v || "no_compatible" in v)) out[k] = v;
  }
  return out;
}

function buildMetadata({ tag, version, base, floor, previous, capabilities, runUrl, suiteRef, now = new Date() }) {
  const warnings = [];
  const meta = { ...(base || {}) };
  meta.schema = 2;
  meta.component = "station_cli";
  meta.tag = tag;
  meta.cli_version = version;
  meta.requires = { ...requiresFrom(floor), ...(meta.requires || {}) };

  const computed = { ...(meta.computed || {}) };
  if (runUrl && !computed.run_url) computed.run_url = runUrl;
  if (suiteRef && !computed.suite_ref) computed.suite_ref = suiteRef;
  if (!computed.at) computed.at = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const carried = new Set(computed.carried_forward || []);

  for (const [field, component] of Object.entries(LEGACY)) {
    const req = meta.requires[component];
    if (req && !req.no_compatible && typeof req.min === "string") {
      meta[field] = req.min;
      carried.delete(field);
    } else if (typeof meta[field] === "string") {
      // `compat metadata` already decided it
    } else if (previous && typeof previous[field] === "string") {
      meta[field] = previous[field];
      carried.add(field);
    } else {
      delete meta[field];
      warnings.push(`${field}: no evidence and no previous release value — left out`);
    }
  }
  if (carried.size) computed.carried_forward = [...carried].sort();
  else delete computed.carried_forward;
  meta.computed = computed;
  if (capabilities) meta.capabilities = capabilities;
  return { meta, warnings };
}

/**
 * The release before `tag` on the same channel (by tag grammar and SemVer
 * precedence, never by date), else the newest release below it on any
 * channel; null when there is none. `tags` are the repository's release tags.
 */
function previousTag(tags, tag) {
  const parse = (t) => {
    const m = /^(dev-)?v(\d+)\.(\d+)\.(\d+)$/.exec(t);
    return m ? { tag: t, dev: !!m[1], n: [Number(m[2]), Number(m[3]), Number(m[4])] } : null;
  };
  // dev-vX.Y.Z is X.Y.Z-dev: below vX.Y.Z.
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] - b.n[i];
    return (a.dev ? 0 : 1) - (b.dev ? 0 : 1);
  };
  const me = parse(tag);
  if (!me) return null;
  const lower = tags.map(parse).filter((t) => t && cmp(t, me) < 0).sort((a, b) => cmp(b, a));
  const same = lower.find((t) => t.dev === me.dev);
  return (same || lower[0] || { tag: null }).tag;
}

module.exports = { buildMetadata, requiresFrom, previousTag };

if (require.main === module && process.argv[2] === "previous-tag") {
  // node scripts/release-metadata.js previous-tag <tag> < tags (one per line)
  const tags = require("node:fs").readFileSync(0, "utf8").split(/\s+/).filter(Boolean);
  const prev = previousTag(tags, process.argv[3] || "");
  if (prev) process.stdout.write(prev + "\n");
} else if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const tag = opt("--tag");
  const version = opt("--version");
  const out = opt("--out");
  if (!tag || !version || !out) {
    console.error("usage: release-metadata.js --tag <tag> --version <X.Y.Z> --out <file> [--base f] [--floor f] [--previous f] [--capabilities f]");
    process.exit(2);
  }
  const { meta, warnings } = buildMetadata({
    tag,
    version,
    base: readJson(opt("--base")),
    floor: readJson(opt("--floor")),
    previous: readJson(opt("--previous")),
    capabilities: readJson(opt("--capabilities")),
    runUrl: opt("--run-url"),
    suiteRef: opt("--suite-ref"),
  });
  for (const w of warnings) console.log(`::warning::metadata.json ${w}`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(meta, null, 2) + "\n");
  console.log(fs.readFileSync(out, "utf8"));
}
