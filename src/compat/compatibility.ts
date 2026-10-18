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
 * between firmware, station_cli and the kiosk, computed by release-compat
 * from contract runs of the real code against real releases. Nothing in this
 * CLI declares a floor by hand any more; it reads them from this file.
 *
 * Pure: parsing, validation and the consumer rule, no I/O (that is
 * `source.ts`), so every branch is unit-tested from fixtures.
 */

export const COMPAT_FORMAT = "compatibility/v1";

/** Which floor a release of one component has towards one other component. */
export interface CompatRequirement {
  /** Lowest compatible version of the other component; null when none is. */
  min: string | null;
  min_tag: string | null;
  /** True when the newest tested release of the other component failed. */
  no_compatible: boolean;
  tested: string[];
  failed: string[];
  evidence: string[];
}

export interface CompatRelease {
  version: string;
  channel: ReleaseChannel;
  requires: Partial<Record<string, CompatRequirement>>;
}

export interface CompatComponent {
  repo: string;
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
          if (req.min !== null && !parseSemVer(req.min as string)) {
            err(`${qat}.min`, "must be a semantic version or null");
          }
          if (req.min_tag !== undefined && req.min_tag !== null && typeof req.min_tag !== "string") {
            err(`${qat}.min_tag`, "must be a string or null");
          }
          if (typeof req.no_compatible !== "boolean") err(`${qat}.no_compatible`, "must be a boolean");
          for (const k of ["tested", "failed", "evidence"]) {
            if (req[k] !== undefined && !isStringArray(req[k])) err(`${qat}.${k}`, "must be a list of strings");
          }
        }
      }
    }
  }
  return errors.length ? { doc: null, errors } : { doc: doc as unknown as CompatibilityDoc, errors };
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
 * release-compat's lib/check.mjs, pinned by the shared parity cases).
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
// The consumer rule
// ---------------------------------------------------------------------------

export interface InstallVerdict {
  installable: boolean;
  /** Why not, one line per broken requirement. Empty when installable. */
  reasons: string[];
  /** Non-blocking observations (an installed build the file does not list). */
  notes: string[];
}

function hasEdge(doc: CompatibilityDoc, a: string, b: string): boolean {
  return doc.edges.some(([x, y]) => x === a && y === b);
}

/**
 * "May I install `component@tag` next to what is installed?" — identical in
 * every consumer (release-compat's `compat check`, the kiosk, the installer):
 *
 *  1. The release must be in the file. Untested means not installable.
 *  2. For each installed component it has an edge with, its own floor
 *     `requires[Y]` must exist, have a compatible version, and be met by every
 *     interpretation of what is installed. Floors are computed in both
 *     directions of an edge; a missing floor on the reverse side of an edge
 *     is tolerated (step 3 covers that direction) and noted.
 *  3. Reverse: each installed component's own release must accept this
 *     version (`requires[X].min <= version`).
 */
export function checkInstall(
  doc: CompatibilityDoc,
  component: ComponentId,
  tag: string,
  installed: InstalledComponent[]
): InstallVerdict {
  const reasons: string[] = [];
  const notes: string[] = [];
  const rel = doc.components[component]?.releases?.[tag];
  if (!rel) {
    return {
      installable: false,
      reasons: [`${component} ${tag} is not in compatibility.json (untested)`],
      notes,
    };
  }
  const version = classifyTag(component, tag)?.version ?? parseSemVer(rel.version);
  if (!version) {
    return { installable: false, reasons: [`${component} ${tag} has no usable version`], notes };
  }

  for (const inst of installed) {
    const Y = inst.component;
    if (Y === component) continue;
    const forward = hasEdge(doc, component, Y);
    const reverse = hasEdge(doc, Y, component);
    if (!forward && !reverse) continue;

    // --- 2: this release's floor towards Y ---------------------------------
    const req = rel.requires?.[Y];
    if (!req) {
      if (forward) reasons.push(`${component} ${tag} was never tested with ${Y}`);
      else notes.push(`${component} ${tag} lists no floor for ${Y}`);
    } else if (req.no_compatible || req.min === null) {
      reasons.push(`${component} ${tag} has no compatible ${Y} release (newest tested failed)`);
    } else {
      const min = parseSemVer(req.min);
      for (const i of inst.interpretations) {
        if (!min || compareSemVer(i.version, min) < 0) {
          reasons.push(
            `${component} ${tag} needs ${Y} >= ${req.min}; ${inst.label} runs ` +
              `${formatSemVer(i.version)}${i.tag ? ` (${i.tag})` : ""}`
          );
        }
      }
    }

    // --- 3: the installed release's floor towards this component ----------
    for (const i of inst.interpretations) {
      const theirs = i.tag ? doc.components[Y]?.releases?.[i.tag] : undefined;
      if (!theirs) {
        notes.push(`${inst.label} (${Y} ${formatSemVer(i.version)}) is not in compatibility.json`);
        continue;
      }
      const back = theirs.requires?.[component];
      if (!back) continue;
      if (back.no_compatible || back.min === null) {
        reasons.push(`${inst.label} (${Y} ${i.tag}) has no compatible ${component} release`);
        continue;
      }
      const min = parseSemVer(back.min);
      if (!min || compareSemVer(version, min) < 0) {
        reasons.push(`${inst.label} (${Y} ${i.tag}) needs ${component} >= ${back.min}; ${tag} is older`);
      }
    }
  }
  return { installable: reasons.length === 0, reasons: [...new Set(reasons)], notes: [...new Set(notes)] };
}
