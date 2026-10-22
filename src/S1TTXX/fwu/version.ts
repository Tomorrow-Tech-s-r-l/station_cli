/**
 * Semantic-version helpers shared by the firmware-update engine.
 *
 * Deliberately dependency-free and pure so the planner can be unit-tested
 * without a serial port or a network. The parsing rules match the ones the
 * kiosk app already applies to release tags (see
 * `StationCliAutoUpdateService._parseVersion` in amperry-kiosk-local), so a
 * tag that resolves on one side resolves identically on the other.
 */

/** `[major, minor, patch]`. Always length 3. */
export type Version = readonly [number, number, number];

/**
 * Parses `1.2.3`, `v1.2.3`, `1.2.3-beta.1`, `1.2` → `[1, 2, 3]`.
 *
 * A missing patch is treated as `0` so firmware built from a two-component
 * version string still compares correctly. Pre-release suffixes are dropped
 * for ordering purposes — the channel, not the suffix, decides eligibility
 * (see `catalog.ts`). Returns `null` when the string is not a version at all.
 */
export function parseVersion(raw: string | null | undefined): Version | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^dev-/, "").replace(/^v/, "");
  const parts = cleaned.split(".");
  if (parts.length < 2) return null;
  const major = Number.parseInt(parts[0], 10);
  const minor = Number.parseInt(parts[1], 10);
  const patch =
    parts.length > 2 ? Number.parseInt(parts[2].split(/[-+]/)[0], 10) : 0;
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  if (major < 0 || minor < 0 || patch < 0) return null;
  return [major, minor, patch];
}

/** Negative when `a < b`, zero when equal, positive when `a > b`. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** `true` when `version >= minimum`. */
export function isAtLeast(version: Version, minimum: Version): boolean {
  return compareVersions(version, minimum) >= 0;
}

/** `1.2.3` */
export function formatVersion(v: Version): string {
  return `${v[0]}.${v[1]}.${v[2]}`;
}

/**
 * Packs a version into the 32-bit word both bootloaders stamp into the app
 * header on END: `(major << 16) | (minor << 8) | patch`.
 *
 * Each field is one byte on the wire, so a component above 255 would silently
 * corrupt its neighbour — clamp instead of wrapping, and let the caller decide
 * whether the clamp matters (it is logged in the plan).
 */
export function toHeaderWord(v: Version): number {
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  return (((clamp(v[0]) << 16) | (clamp(v[1]) << 8) | clamp(v[2])) >>> 0);
}

/** `true` when any component would not survive {@link toHeaderWord}. */
export function overflowsHeaderWord(v: Version): boolean {
  return v[0] > 255 || v[1] > 255 || v[2] > 255;
}

/**
 * Strips the channel prefix from a release tag: `v1.2.3` and `dev-v1.2.3`
 * both yield `1.2.3`. Returns the input trimmed when no prefix matched.
 */
export function versionStringFromTag(tag: string): string {
  return tag.trim().replace(/^dev-/, "").replace(/^v/, "");
}
