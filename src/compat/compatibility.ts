import {
  ComponentId,
  ReleaseChannel,
  SemVer,
  classifyTag,
  compareSemVer,
  formatSemVer,
  parseSemVer,
  sameCore,
} from "./semver";

/**
 * `compatibility.json` (format `compatibility/v1`): the minimum versions
 * between firmware, station_cli and the kiosk, computed by release-compatibility-cli
 * from contract runs of the real code against real releases. Nothing in this
 * CLI declares a floor by hand any more; it reads them from this file.
 *
 * Pure: parsing, validation and the consumer rule, no I/O (that is
 * `source.ts`), so every branch is unit-tested from fixtures.
 */

export const COMPAT_FORMAT = "compatibility/v1";

/** A floor over one set of tested releases of the other component. */
export interface CompatFloor {
  /** Lowest compatible version of the other component; null when none is. */
  min: string | null;
  min_tag: string | null;
  /** True when the newest tested release of the other component failed (or none was tested). */
  no_compatible: boolean;
  /** Why there is no floor, when there is none (e.g. `untested`). */
  reason?: string;
  tested: string[];
  failed: string[];
  unknown?: string[];
  /**
   * Legacy releases of the other component, untested or without a result,
   * that the floor was lowered past (no older tested release failed, so lack
   * of testing does not raise it).
   */
  untested_legacy?: string[];
}

/**
 * Which floor a release of one component has towards one other component.
 * The top level is the floor over every tested release of the other
 * component; `channels` splits it by the channel of the INSTALLING station
 * (see channelFloor).
 */
export interface CompatRequirement extends CompatFloor {
  evidence: string[];
  /**
   * production: the floor over production releases of the other component
   * only — a production station installs nothing else, so a failing dev
   * release does not hold it back. development: over both channels (the
   * same as the top level). Absent in files written before the split.
   */
  channels?: Record<ReleaseChannel, CompatFloor>;
}

export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ["production", "development"];

export interface CompatRelease {
  version: string;
  channel: ReleaseChannel;
  requires: Partial<Record<string, CompatRequirement>>;
}

export interface CompatComponent {
  repo: string;
  /**
   * The cutover: the oldest release published with computed metadata (see
   * isLegacy). null = every release is legacy; absent (a file written before
   * cutovers existed) = every release is enforced.
   */
  enforced_from?: string | null;
  enforced_from_version?: string | null;
  releases: Record<string, CompatRelease>;
}

export interface CompatibilityDoc {
  format: typeof COMPAT_FORMAT;
  sequence: number;
  generated_at: string;
  edges: Array<[string, string]>;
  components: Partial<Record<string, CompatComponent>>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Validates a parsed document. Any structural error rejects the WHOLE file:
 * a half-understood compatibility file is worse than none, because the
 * fallback (cache, bundled copy, or refusing to update) is well defined.
 */
export function validateCompatibility(doc: unknown): { doc: CompatibilityDoc | null; errors: string[] } {
  const errors: string[] = [];
  const err = (p: string, m: string) => errors.push(`${p}: ${m}`);
  if (!isObject(doc)) return { doc: null, errors: ["(root): must be a JSON object"] };

  if (doc.format !== COMPAT_FORMAT) {
    err("format", `expected "${COMPAT_FORMAT}", got ${JSON.stringify(doc.format)}`);
  }
  if (typeof doc.sequence !== "number" || !Number.isInteger(doc.sequence) || doc.sequence < 0) {
    err("sequence", "must be a non-negative integer");
  }
  if (doc.generated_at !== undefined && typeof doc.generated_at !== "string") {
    err("generated_at", "must be a string");
  }
  if (
    !Array.isArray(doc.edges) ||
    !doc.edges.every((e) => Array.isArray(e) && e.length === 2 && e.every((s) => typeof s === "string"))
  ) {
    err("edges", "must be a list of [component, component] pairs");
  }
  if (!isObject(doc.components)) {
    err("components", "must be an object");
  } else {
    for (const [id, comp] of Object.entries(doc.components)) {
      const at = `components.${id}`;
      if (!isObject(comp)) {
        err(at, "must be an object");
        continue;
      }
      if (typeof comp.repo !== "string") err(`${at}.repo`, "must be a string");
      if (comp.enforced_from !== undefined && comp.enforced_from !== null && typeof comp.enforced_from !== "string") {
        err(`${at}.enforced_from`, "must be a release tag or null");
      }
      if (
        comp.enforced_from_version !== undefined &&
        comp.enforced_from_version !== null &&
        !parseSemVer(comp.enforced_from_version as string)
      ) {
        err(`${at}.enforced_from_version`, "must be a semantic version or null");
      }
      if (!isObject(comp.releases)) {
        err(`${at}.releases`, "must be an object");
        continue;
      }
      for (const [tag, rel] of Object.entries(comp.releases)) {
        const rat = `${at}.releases.${tag}`;
        if (!isObject(rel)) {
          err(rat, "must be an object");
          continue;
        }
        if (!parseSemVer(rel.version as string)) err(`${rat}.version`, "must be a semantic version");
        if (rel.channel !== "production" && rel.channel !== "development") {
          err(`${rat}.channel`, 'must be "production" or "development"');
        }
        if (!isObject(rel.requires)) {
          err(`${rat}.requires`, "must be an object");
          continue;
        }
        for (const [dep, req] of Object.entries(rel.requires)) {
          const qat = `${rat}.requires.${dep}`;
          if (!isObject(req)) {
            err(qat, "must be an object");
            continue;
          }
          validateFloor(qat, req, err);
          if (req.evidence !== undefined && !isStringArray(req.evidence)) err(`${qat}.evidence`, "must be a list of strings");
          if (req.channels === undefined) continue;
          if (!isObject(req.channels)) {
            err(`${qat}.channels`, "must be an object");
            continue;
          }
          for (const ch of RELEASE_CHANNELS) {
            const floor = req.channels[ch];
            if (!isObject(floor)) err(`${qat}.channels.${ch}`, "must be an object");
            else validateFloor(`${qat}.channels.${ch}`, floor, err);
          }
        }
      }
    }
  }
  return errors.length ? { doc: null, errors } : { doc: doc as unknown as CompatibilityDoc, errors };
}

function validateFloor(at: string, floor: Record<string, unknown>, err: (p: string, m: string) => void): void {
  if (floor.min !== null && !parseSemVer(floor.min as string)) {
    err(`${at}.min`, "must be a semantic version or null");
  }
  if (floor.min_tag !== undefined && floor.min_tag !== null && typeof floor.min_tag !== "string") {
    err(`${at}.min_tag`, "must be a string or null");
  }
  if (typeof floor.no_compatible !== "boolean") err(`${at}.no_compatible`, "must be a boolean");
  for (const k of ["tested", "failed", "unknown", "untested_legacy"]) {
    if (floor[k] !== undefined && !isStringArray(floor[k])) err(`${at}.${k}`, "must be a list of strings");
  }
}

/** Parses and validates file contents. Never throws. */
export function parseCompatibility(text: string): { doc: CompatibilityDoc | null; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { doc: null, errors: [`not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return validateCompatibility(raw);
}

// ---------------------------------------------------------------------------
// What is installed
// ---------------------------------------------------------------------------

/** One way of reading what an installed component is. */
export interface Interpretation {
  /** The release tag it corresponds to, when the file lists one. */
  tag: string | null;
  version: SemVer;
}

/**
 * An installed component. A device reports only `X.Y.Z` — the firmware of
 * `v3.2.0` and of `dev-v3.2.0` answer the same — so one installed device can
 * stand for several releases. Every interpretation must pass for an install
 * to be allowed: when we cannot tell which build is running, we assume the
 * one the data is least happy with.
 */
export interface InstalledComponent {
  component: ComponentId;
  /** For messages, e.g. `interface board 0`. */
  label: string;
  interpretations: Interpretation[];
}

/**
 * Maps a reported version onto the releases the file knows (the readings of
 * release-compatibility-cli's lib/check.mjs, pinned by the shared parity cases).
 *
 * - An exact tag (this CLI knows its own) is used as is.
 * - A version with a pre-release (`3.2.0-dev`) matches that release only.
 * - A bare `X.Y.Z` is both `vX.Y.Z` and `dev-vX.Y.Z`: a dev build reports
 *   the bare version too, and nothing the device reports tells them apart —
 *   not the update channel either (a station switched from beta to stable
 *   still runs its dev build until the next flash). Every reading must pass.
 * - A version the file does not list still counts, as itself, without a tag.
 */
export function interpretInstalled(
  doc: CompatibilityDoc,
  component: ComponentId,
  reported: string,
  label: string,
  opts: { tag?: string | null } = {}
): InstalledComponent | null {
  const releases = doc.components[component]?.releases ?? {};
  if (opts.tag) {
    const classified = classifyTag(component, opts.tag);
    const version = classified?.version ?? parseSemVer(releases[opts.tag]?.version) ?? parseSemVer(reported);
    if (version) return { component, label, interpretations: [{ tag: opts.tag, version }] };
  }
  const version = parseSemVer(reported);
  if (!version) return null;

  const interpretations: Interpretation[] = [];
  for (const [tag, rel] of Object.entries(releases)) {
    const v = parseSemVer(rel.version);
    if (!v) continue;
    const same = version.prerelease.length
      ? compareSemVer(v, version) === 0
      : sameCore(v, version) && (v.prerelease.length === 0 || (v.prerelease.length === 1 && v.prerelease[0] === "dev"));
    if (same) interpretations.push({ tag, version: v });
  }
  if (!interpretations.length) interpretations.push({ tag: null, version });
  return { component, label, interpretations };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * The release channel of a station on this CLI's update channel: `stable`
 * installs production releases only, `beta` both.
 */
export function stationChannel(channel: "stable" | "beta"): ReleaseChannel {
  return channel === "stable" ? "production" : "development";
}

/**
 * The floor a station of `channel` uses (release-compatibility-cli's `channelFloor`):
 * `requires[Y].channels[channel]`; with no channel, or a file without
 * `channels`, the top level (= the development floor).
 */
export function channelFloor(
  req: CompatRequirement | undefined,
  channel: ReleaseChannel | null | undefined
): CompatFloor | undefined {
  if (!req) return req;
  return (channel && req.channels?.[channel]) || req;
}

// ---------------------------------------------------------------------------
// The cutover
// ---------------------------------------------------------------------------

/**
 * `components[X].enforced_from` as the file states it: a tag, null (every
 * release legacy), or undefined when the file predates cutovers.
 */
export function cutoverOf(doc: CompatibilityDoc, component: string): string | null | undefined {
  const entry = doc.components[component];
  return entry && Object.prototype.hasOwnProperty.call(entry, "enforced_from") ? entry.enforced_from : undefined;
}

/**
 * True when `version` of `component` is a LEGACY release: published before
 * the cutover, i.e. before release jobs wrote computed metadata. Missing
 * evidence never breaks a legacy release; it keeps the behaviour it shipped
 * with (release-compatibility-cli's lib/cutover.mjs `isLegacyVersion`):
 *
 * - no `enforced_from` in the file: nothing is legacy (the strict rule);
 * - `enforced_from: null`: everything is legacy;
 * - else legacy iff `version < enforced_from` (an unreadable tag: not legacy).
 */
export function isLegacy(doc: CompatibilityDoc, component: ComponentId, version: SemVer): boolean {
  const enforced = cutoverOf(doc, component);
  if (enforced === undefined) return false;
  if (enforced === null) return true;
  const from = classifyTag(component, enforced);
  return from ? compareSemVer(version, from.version) < 0 : false;
}

/** A release's floor on an edge is evidence iff it exists and tested something on that channel. */
function hasEvidence(floor: CompatFloor | undefined): boolean {
  return !!floor && (!Array.isArray(floor.tested) || floor.tested.length > 0);
}

/** The floor tested exactly `tag` and it FAILED. */
function testedFail(floor: CompatFloor | undefined, tag: string | null | undefined): boolean {
  return !!tag && Array.isArray(floor?.failed) && floor.failed.includes(tag);
}

/** The floor tested exactly `tag` and it PASSED (tested, not failed, not unknown). */
function testedPass(floor: CompatFloor | undefined, tag: string | null | undefined): boolean {
  return (
    !!tag &&
    Array.isArray(floor?.tested) &&
    floor.tested.includes(tag) &&
    !(floor.failed ?? []).includes(tag) &&
    !(floor.unknown ?? []).includes(tag)
  );
}

// ---------------------------------------------------------------------------
// The consumer rule
// ---------------------------------------------------------------------------

export interface InstallVerdict {
  installable: boolean;
  /** The installing station's channel whose floors were read; null = the top level. */
  channel: ReleaseChannel | null;
  /** True when the candidate is a legacy release (published before the cutover). */
  legacy: boolean;
  /**
   * Components this candidate gets NO computed constraint towards: legacy
   * pairs nobody tested. The consumer applies the rule the candidate shipped
   * with to them (for firmware: the release's `metadata.json`
   * `min_cli_version`). Empty for an enforced candidate.
   */
  untestedLegacy: ComponentId[];
  /** Why not, one line per broken requirement. Empty when installable. */
  reasons: string[];
  /** Non-blocking observations (an installed build the file does not list). */
  notes: string[];
}

/** release-compatibility-cli's `reason` for a floor with no compatible version. */
const NO_FLOOR_WHY: Record<string, string> = {
  newest_failed: "newest tested failed",
  newest_unknown: "newest tested has no result",
  untested: "none of that channel was tested",
};

function hasEdge(doc: CompatibilityDoc, a: string, b: string): boolean {
  return doc.edges.some(([x, y]) => x === a && y === b);
}

/**
 * "May I install `component@tag` next to what is installed, on a station of
 * `channel`?" — identical in every consumer (release-compatibility-cli's `compat
 * check`, the kiosk, the installer). Every floor below is the one for the
 * installing station's channel (channelFloor).
 *
 * A release is LEGACY (published before the cutover, see isLegacy) or
 * ENFORCED; a file without `enforced_from` is read the way it was before
 * cutovers (CLASSIC: every release enforced, without step 0 and 2a).
 *
 *  0. Legacy candidate: a pair where the candidate has no evidence on the
 *     edge, or where the installed release is legacy and has no evidence on
 *     it, gets NO computed constraint (`untestedLegacy`): the candidate's own
 *     legacy rule decides it. Only a TESTED failure blocks a legacy pair. A
 *     legacy candidate the file does not list is such a pair for everything.
 *     A failure the candidate's floor records for that installed release
 *     still blocks; a pair tested and PASSED is not held back by a legacy
 *     side's floor (2 for a legacy candidate, 3 for a legacy installed one),
 *     even one whose newest tested release failed (`no_compatible`).
 *  1. Otherwise the release must be in the file. Untested means not installable.
 *  2a. Enforced candidate: it needs a computed floor for every edge of its
 *     component, installed or not.
 *  2. For each installed component it has an edge with, its own floor
 *     `requires[Y]` must exist, have a compatible version, and be met by every
 *     interpretation of what is installed. Floors are computed in both
 *     directions of an edge; CLASSIC tolerates a missing floor on the
 *     reverse side of an edge (step 3 covers that direction) and notes it.
 *  3. Reverse: each installed component's own release must accept this
 *     version (`requires[X].min <= version`). An installed LEGACY release
 *     whose floor tested nothing on this channel imposes no constraint.
 */
export function checkInstall(
  doc: CompatibilityDoc,
  component: ComponentId,
  tag: string,
  installed: InstalledComponent[],
  opts: { channel?: ReleaseChannel | null } = {}
): InstallVerdict {
  const channel = opts.channel ?? null;
  const reasons: string[] = [];
  const notes: string[] = [];
  const untestedLegacy: ComponentId[] = [];
  const on = channel ? ` for a ${channel} station` : "";
  const rel = doc.components[component]?.releases?.[tag];
  const version = classifyTag(component, tag)?.version ?? parseSemVer(rel?.version);
  const verdict = (legacy: boolean): InstallVerdict => ({
    installable: reasons.length === 0,
    channel,
    legacy,
    untestedLegacy,
    reasons: [...new Set(reasons)],
    notes: [...new Set(notes)],
  });
  if (!version) {
    reasons.push(
      rel ? `${component} ${tag} has no usable version` : `${component} ${tag} is not a ${component} release tag`
    );
    return verdict(false);
  }

  const classic = cutoverOf(doc, component) === undefined;
  const legacy = isLegacy(doc, component, version);
  const neighbours = [
    ...new Set(doc.edges.flatMap(([a, b]) => (a === component ? [b] : b === component ? [a] : []))),
  ] as ComponentId[];
  const leaveToLegacy = (Y: ComponentId, why: string) => {
    if (!untestedLegacy.includes(Y)) untestedLegacy.push(Y);
    notes.push(`untested-legacy: ${why}; no computed constraint, the legacy rule applies`);
  };

  // --- 1 (and 0 for a legacy release the file does not list) --------------
  if (!rel) {
    if (!legacy) {
      reasons.push(`${component} ${tag} is not in compatibility.json (untested)`);
      return verdict(false);
    }
    for (const inst of installed) {
      if (inst.component !== component && neighbours.includes(inst.component)) {
        leaveToLegacy(inst.component, `legacy ${tag} has no computed compatibility (${inst.component})`);
      }
    }
    notes.push(`untested-legacy: legacy ${component} ${tag} has no computed compatibility; the legacy rule applies`);
    return verdict(true);
  }

  // --- 2a: an enforced release has a floor for every edge -----------------
  if (!classic && !legacy) {
    for (const Y of neighbours) {
      if (!rel.requires?.[Y]) reasons.push(`${component} ${tag} is enforced and has no computed floor for ${Y}`);
    }
  }

  for (const inst of installed) {
    const Y = inst.component;
    if (Y === component) continue;
    const forward = hasEdge(doc, component, Y);
    const reverse = hasEdge(doc, Y, component);
    if (!forward && !reverse) continue;

    const req = channelFloor(rel.requires?.[Y], channel);
    for (const i of inst.interpretations) {
      const theirs = i.tag ? doc.components[Y]?.releases?.[i.tag] : undefined;
      const back = theirs ? channelFloor(theirs.requires?.[component], channel) : undefined;
      const as = `${inst.label} (${Y} ${i.tag ?? formatSemVer(i.version)})`;

      // --- 0: a legacy pair without evidence on the edge ------------------
      if (
        legacy &&
        (!hasEvidence(req) || (!hasEvidence(back) && isLegacy(doc, Y, i.version) && !testedFail(req, i.tag)))
      ) {
        leaveToLegacy(
          Y,
          !hasEvidence(req) ? `legacy ${tag} was never tested with ${Y}` : `legacy ${as} was never tested with ${component}`
        );
        continue;
      }

      // --- 2: this release's floor towards Y -------------------------------
      if (!req) {
        if (classic && forward) reasons.push(`${component} ${tag} was never tested with ${Y}`);
        else if (classic) notes.push(`${component} ${tag} lists no floor for ${Y}`);
      } else if (legacy && testedPass(req, i.tag)) {
        notes.push(`legacy ${component} ${tag} was tested with ${as} and passed`);
      } else if (req.no_compatible || req.min === null) {
        reasons.push(
          `${component} ${tag} has no compatible ${Y} release${on} ` +
            `(${NO_FLOOR_WHY[req.reason ?? ""] ?? "newest tested failed"})`
        );
      } else {
        const min = parseSemVer(req.min);
        if (!min || compareSemVer(i.version, min) < 0) {
          reasons.push(
            `${component} ${tag} needs ${Y} >= ${req.min}; ${inst.label} runs ` +
              `${formatSemVer(i.version)}${i.tag ? ` (${i.tag})` : ""}`
          );
        }
      }

      // --- 3: the installed release's floor towards this component --------
      if (!theirs) {
        notes.push(`${inst.label} (${Y} ${formatSemVer(i.version)}) is not in compatibility.json`);
        continue;
      }
      if (!back) continue;
      // A legacy installed release that tested nothing on this channel
      // imposes no constraint (G2); this release's own floor covered it.
      if (!hasEvidence(back) && isLegacy(doc, Y, i.version)) {
        notes.push(`untested-legacy: ${as} was never tested with ${component} on this channel; no reverse constraint`);
        continue;
      }
      // ...nor does its floor hold back a release it was tested with and passed.
      if (isLegacy(doc, Y, i.version) && testedPass(back, tag)) {
        notes.push(`${as} is legacy and was tested with ${component} ${tag} and passed`);
        continue;
      }
      if (back.no_compatible || back.min === null) {
        reasons.push(`${as} has no compatible ${component} release${on}`);
        continue;
      }
      const min = parseSemVer(back.min);
      if (!min || compareSemVer(version, min) < 0) {
        reasons.push(`${as} needs ${component} >= ${back.min}; ${tag} is older`);
      }
    }
  }
  return verdict(legacy);
}
