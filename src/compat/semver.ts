/**
 * Semantic Versioning 2.0 precedence and the release-tag grammar shared by
 * every component that reads `compatibility.json`.
 *
 * `fwu/version.ts` keeps its three-number `Version` — that is what the app
 * header stores and what a device reports. This module is the other half: the
 * order of RELEASES, where a pre-release ranks below its release
 * (`0.5.0-dev < 0.5.0`) and `dev.N` compares numerically. The rules are the
 * ones release-compatibility-cli computes floors with (its `lib/semver.mjs`); a tag must
 * sort identically here, in the kiosk and in the installer, or a floor would
 * mean different things to different readers.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers; numeric ones as numbers. Empty for a release. */
  prerelease: ReadonlyArray<string | number>;
}

/** The four components `compatibility.json` names. */
export type ComponentId = "kiosk" | "station_cli" | "S1TTXX" | "P1TT2C";

export type ReleaseChannel = "production" | "development";

const NUMERIC = /^(0|[1-9]\d*)$/;
const IDENT = /^[0-9A-Za-z-]+$/;
const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parses a full `X.Y.Z[-pre][+build]` version (a leading `v` is tolerated).
 * Returns null for anything else — including `1.2`, which is not a release.
 */
export function parseSemVer(raw: string | null | undefined): SemVer | null {
  if (typeof raw !== "string") return null;
  const m = SEMVER.exec(raw.trim());
  if (!m) return null;
  const prerelease: Array<string | number> = [];
  if (m[4] !== undefined) {
    for (const id of m[4].split(".")) {
      if (!id || !IDENT.test(id)) return null;
      // A numeric identifier with a leading zero is invalid in SemVer 2.0.
      if (/^\d+$/.test(id) && !NUMERIC.test(id)) return null;
      prerelease.push(NUMERIC.test(id) ? Number(id) : id);
    }
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

/** Negative when `a < b`, zero when equal precedence, positive when `a > b`. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  const pa = a.prerelease;
  const pb = b.prerelease;
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length; // release > pre-release
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1; // numeric identifiers rank below alphanumeric
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

/** `1.2.3` or `1.2.3-dev.4`. Build metadata is not kept. */
export function formatSemVer(v: SemVer): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length ? `${core}-${v.prerelease.join(".")}` : core;
}

/** True when both versions share `X.Y.Z`, whatever their pre-release. */
export function sameCore(a: SemVer, b: SemVer): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/** A release tag classified by the grammar of its component. */
export interface ClassifiedTag {
  tag: string;
  version: SemVer;
  channel: ReleaseChannel;
}

/**
 * Classifies a release tag by its text — never by GitHub's `prerelease` flag,
 * which is set by hand and has been wrong before.
 *
 *   station_cli, S1TTXX, P1TT2C   vX.Y.Z → production; dev-vX.Y.Z → development (X.Y.Z-dev)
 *   kiosk                         vX.Y.Z → production; vX.Y.Z-dev.N → development
 *
 * Anything else (legacy timestamp tags, hand-made tags) is not a release of
 * the component and returns null.
 */
export function classifyTag(component: ComponentId, tag: string): ClassifiedTag | null {
  const t = (tag ?? "").trim();
  const prod = /^v(\d+)\.(\d+)\.(\d+)$/.exec(t);
  const make = (m: RegExpExecArray, prerelease: Array<string | number>, channel: ReleaseChannel) => {
    const nums = [m[1], m[2], m[3]];
    if (!nums.every((n) => NUMERIC.test(n))) return null;
    return {
      tag: t,
      version: { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease },
      channel,
    };
  };
  if (prod) return make(prod, [], "production");
  if (component === "kiosk") {
    const dev = /^v(\d+)\.(\d+)\.(\d+)-dev\.(\d+)$/.exec(t);
    return dev && NUMERIC.test(dev[4]) ? make(dev, ["dev", Number(dev[4])], "development") : null;
  }
  const dev = /^dev-v(\d+)\.(\d+)\.(\d+)$/.exec(t);
  return dev ? make(dev, ["dev"], "development") : null;
}
