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
 *   node scripts/release-metadata.js previous-tags <tag> < tags.txt
 *     prints the releases before <tag> whose metadata.json a legacy value may
 *     be carried from, best first (same channel first, then any).
 *
 * Nothing here is a floor written by hand. The values come from, in order:
 *   - the contract evidence of this run (`--floor`, computed by
 *     release-compat): it wins over `--base` for every component it covers,
 *     because the published compatibility.json cannot have seen this run yet
 *     (for a tag that is published again it holds the previous build's);
 *   - the published compatibility.json (`--base`) for the rest (the kiosk
 *     floor, from the kiosk's own contract runs);
 *   - for a legacy field, the floor of THIS release's channel
 *     (`requires[Y].channels[channel]`): a kiosk in the field knows no
 *     channels, and a release is only ever installed by stations of its own
 *     channel, so a production release gets the floor over production
 *     kiosks. Its X.Y.Z (legacy parsers know no pre-release); with no
 *     compatible release at all, one patch above the newest one tested,
 *     listed in `computed.legacy_blocked` (an old kiosk must not read "no
 *     floor"); with no evidence of that channel, a value carried from
 *     something COMPUTED, listed in `computed.carried_forward` with its
 *     origin in `computed.carried_from`:
 *       1. what `compat metadata` carried into `--base` (it was given the
 *          published compatibility.json as `--carry-compat`: the floor of
 *          this channel of the newest earlier release in that file backed by
 *          evidence — origin {source: "compatibility.json", sequence, tag,
 *          evidence}; else a computed previous metadata.json);
 *       2. else the previous release's value, when that value was itself
 *          computed (schema 2 with a `computed.run_url`; a value it carried
 *          names its origin in `computed.carried_from`);
 *   - otherwise the script fails (exit 2) and so does the release — never a
 *     literal, never a value without provenance.
 * These are release-compat's legacy rules (lib/metadata.mjs).
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

/** `X.Y.Z` of a version or tag (`v1.4.0-dev.23` → `1.4.0`); null when it has none. */
function core(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** One patch above the newest X.Y.Z tested (the legacy value of "nothing is compatible"). */
function abovePatch(tested) {
  const cores = (tested || []).map(core).filter(Boolean).map((c) => c.split(".").map(Number));
  if (!cores.length) return null;
  cores.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [x, y, z] = cores.at(-1);
  return `${x}.${y}.${z + 1}`;
}

/** The channel of a station_cli release, by tag grammar. */
function channelOf(tag) {
  if (/^v\d+\.\d+\.\d+$/.test(tag)) return "production";
  if (/^dev-v\d+\.\d+\.\d+$/.test(tag)) return "development";
  return null;
}

/**
 * The floor a station of `channel` uses (release-compat's channelFloor):
 * `channels[channel]`, else the top level (files from before the split).
 */
function channelFloor(req, channel) {
  if (!req) return req;
  return (channel && req.channels && req.channels[channel]) || req;
}

/**
 * True when a `computed.carried_from` entry names what computed the value:
 * a run ({run_url}) or a compatibility.json entry with its evidence runs.
 */
function isProvenance(from) {
  if (!from || typeof from !== "object") return false;
  if (typeof from.run_url === "string" && from.run_url) return true;
  return from.source === "compatibility.json" && Array.isArray(from.evidence) && from.evidence.some((e) => typeof e === "string" && e);
}

/** What `compat metadata` carried into `--base` for `field`, {value, source}, or null. */
function baseCarried(base, field) {
  const c = base && base.computed;
  if (!c || !(c.carried_forward || []).includes(field) || typeof base[field] !== "string") return null;
  const from = c.carried_from && c.carried_from[field];
  return isProvenance(from) ? { value: base[field], source: copySource(from) } : null;
}

function copySource(from) {
  return from.run_url ? { tag: from.tag ?? null, run_url: from.run_url } : { ...from, evidence: [...from.evidence] };
}

function describeSource(s) {
  return s.run_url ? `computed by ${s.run_url}` : `compatibility.json sequence ${s.sequence}, computed by ${s.evidence.join(", ")}`;
}

/**
 * Where the previous release's legacy `field` was computed, {tag, run_url}
 * (or the compatibility.json entry it was carried from), or null when it has
 * no provenance and may not be carried (release-compat's computedSource).
 */
function computedSource(previous, field) {
  const c = previous && previous.computed;
  if (!previous || previous.schema !== 2 || typeof previous[field] !== "string" || !c || typeof c.run_url !== "string" || !c.run_url) {
    return null;
  }
  if ((c.uncomputed || []).includes(field)) return null;
  if ((c.carried_forward || []).includes(field)) {
    const from = c.carried_from && c.carried_from[field];
    return isProvenance(from) ? copySource(from) : null;
  }
  return { tag: previous.tag ?? null, run_url: c.run_url };
}

class MetadataError extends Error {}

function buildMetadata({ tag, version, base, floor, previous, capabilities, runUrl, suiteRef, now = new Date() }) {
  const channel = channelOf(tag);
  if (!channel) throw new MetadataError(`"${tag}" is not a station_cli release tag (vX.Y.Z or dev-vX.Y.Z)`);
  const warnings = [];
  const meta = { ...(base || {}) };
  const carriedByBase = Object.fromEntries(Object.keys(LEGACY).map((f) => [f, baseCarried(base, f)]));
  meta.schema = 2;
  meta.component = "station_cli";
  meta.tag = tag;
  meta.channel = channel;
  meta.cli_version = version;
  meta.requires = { ...(meta.requires || {}), ...requiresFrom(floor) };

  const computed = { ...(meta.computed || {}) };
  if (runUrl && !computed.run_url) computed.run_url = runUrl;
  if (suiteRef && !computed.suite_ref) computed.suite_ref = suiteRef;
  computed.run_url ??= null;
  computed.suite_ref ??= null;
  if (!computed.at) computed.at = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  delete computed.uncomputed;
  const carried = new Set();
  const carriedFrom = {};
  const blocked = new Set(computed.legacy_blocked || []);

  for (const [field, component] of Object.entries(LEGACY)) {
    // A channel floor nothing of that channel was tested for is no evidence.
    let req = channelFloor(meta.requires[component], channel);
    if (req && Array.isArray(req.tested) && req.tested.length === 0) req = null;
    blocked.delete(field);
    if (req && !req.no_compatible && core(req.min)) {
      meta[field] = core(req.min);
    } else if (req && abovePatch(req.tested)) {
      meta[field] = abovePatch(req.tested);
      blocked.add(field);
    } else {
      const fromBase = carriedByBase[field];
      const source = fromBase ? fromBase.source : computedSource(previous, field);
      if (!source) {
        throw new MetadataError(
          `${field}: no ${channel} ${component} evidence for ${tag}, nothing computed carried from the published compatibility.json, and ` +
            (previous ? "the previous release's value has no computed provenance" : "no previous computed value") +
            ` — run the ${component} contract with this release, then publish again`
        );
      }
      meta[field] = fromBase ? fromBase.value : previous[field];
      carried.add(field);
      carriedFrom[field] = source;
      warnings.push(`${field} carried forward from ${source.tag ?? "the previous release"} (${describeSource(source)})`);
    }
  }
  computed.carried_forward = [...carried].sort();
  if (carried.size) computed.carried_from = carriedFrom;
  else delete computed.carried_from;
  if (blocked.size) computed.legacy_blocked = [...blocked].sort();
  else delete computed.legacy_blocked;
  meta.computed = computed;
  if (capabilities) meta.capabilities = capabilities;
  return { meta, warnings };
}

/**
 * The releases before `tag` (by tag grammar and SemVer precedence, never by
 * date), best first: the same channel, newest first, then the other channel.
 * `tags` are the repository's release tags. The release job takes the first
 * whose metadata.json is computed (`has-provenance`).
 */
function previousTags(tags, tag) {
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
  return [...lower.filter((t) => t.dev === me.dev), ...lower.filter((t) => t.dev !== me.dev)].map((t) => t.tag);
}

/** The release before `tag` a legacy value is carried from first; null when there is none. */
function previousTag(tags, tag) {
  return previousTags(tags, tag)[0] ?? null;
}

/** True when a metadata.json is computed (schema 2 with a run_url): it may be carried from. */
function hasProvenance(meta) {
  return !!meta && meta.schema === 2 && !!meta.computed && typeof meta.computed.run_url === "string" && !!meta.computed.run_url;
}

module.exports = { buildMetadata, requiresFrom, previousTag, previousTags, computedSource, hasProvenance, isProvenance, channelFloor, MetadataError };

if (require.main === module && process.argv[2] === "previous-tags") {
  // node scripts/release-metadata.js previous-tags <tag> < tags (one per line)
  const tags = require("node:fs").readFileSync(0, "utf8").split(/\s+/).filter(Boolean);
  for (const t of previousTags(tags, process.argv[3] || "")) process.stdout.write(t + "\n");
} else if (require.main === module && process.argv[2] === "has-provenance") {
  // node scripts/release-metadata.js has-provenance <metadata.json>: exit 0 iff computed
  process.exit(hasProvenance(readJson(process.argv[3])) ? 0 : 1);
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
  let result;
  try {
    result = buildMetadata({
      tag,
      version,
      base: readJson(opt("--base")),
      floor: readJson(opt("--floor")),
      previous: readJson(opt("--previous")),
      capabilities: readJson(opt("--capabilities")),
      runUrl: opt("--run-url"),
      suiteRef: opt("--suite-ref"),
    });
  } catch (e) {
    if (!(e instanceof MetadataError)) throw e;
    console.log(`::error::metadata.json ${e.message}`);
    process.exit(2);
  }
  const { meta, warnings } = result;
  for (const w of warnings) console.log(`::warning::metadata.json ${w}`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(meta, null, 2) + "\n");
  console.log(fs.readFileSync(out, "utf8"));
}
