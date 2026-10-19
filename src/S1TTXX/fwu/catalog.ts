import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { httpGetJson, httpDownloadToFile, httpGetBuffer, HttpError } from "./http";
import {
  Version,
  parseVersion,
  compareVersions,
  formatVersion,
  versionStringFromTag,
  isAtLeast,
} from "./version";
import { Channel, ReleaseCandidate, TargetKind } from "./types";
import { Secret } from "../../config/secret";
import { FirmwareSourceConfig } from "../../config/schema";
import { ComponentId, classifyTag, compareSemVer, parseSemVer } from "../../compat/semver";
import { InstalledComponent, channelFloor, checkInstall, stationChannel } from "../../compat/compatibility";
import { CompatLoad } from "../../compat/source";

/**
 * Resolves which firmware build each device class *should* be running, from
 * the GitHub Releases of the repository configured for it, and keeps the
 * downloaded images in a verified on-disk cache.
 *
 * Where firmware comes from is configuration (`firmware.sources`), never
 * source code: this binary is published and carries no deployment knowledge.
 *
 * ## Which release may be installed
 * For a `github` source the answer comes from compatibility.json (see
 * src/compat): release tags are classified by their grammar (`vX.Y.Z`
 * production, `dev-vX.Y.Z` development), walked newest first in SemVer order,
 * and the first one the consumer rule accepts — tested, and compatible both
 * ways with this CLI and with the firmware installed on the station — wins.
 * No compatibility data means nothing is installed: the catalog fails closed.
 *
 * Releases published before the cutover (`enforced_from`, see
 * src/compat/compatibility.ts `isLegacy`) are LEGACY: missing evidence never
 * blocks them. For a pair nobody tested (`untestedLegacy`), the release keeps
 * the rule it shipped with — towards this CLI, its `metadata.json`
 * `min_cli_version` (absent meaning no floor); towards the board or the packs,
 * none, as before compatibility.json. A TESTED failure still blocks it.
 *
 * A `dir` source (bench and emulator builds that were never published, so
 * cannot be in compatibility.json) keeps the legacy rule: the release folder's
 * own `metadata.json` `min_cli_version`, absent meaning no floor.
 */

/** The compatibility.json component each device class runs. */
export const COMPONENT_OF: Record<TargetKind, ComponentId> = {
  interface: "S1TTXX",
  powerbank: "P1TT2C",
};

/** Skipped releases listed one by one in the warnings before the rest are summarised. */
const SKIP_DETAIL_LIMIT = 5;

/**
 * Built-in default for which asset is the application image, per device
 * class. These name the device families this CLI's protocol supports, not any
 * deployment, and a source can override them with `assetPattern`.
 */
const DEFAULT_ACCEPT: Record<TargetKind, string> = {
  interface: "^S1TTXX-firmware-[0-9][^/]*\\.bin$",
  powerbank: "^P1TT2C-firmware-[0-9][^/]*\\.bin$",
};

/**
 * Asset names ALWAYS refused, whatever the configuration says.
 *
 * Both firmware families also publish a `merged` image (bootloader + header +
 * app, linked at 0x08000000) for SWD bring-up of a blank MCU. Streamed through
 * the update path it would write bootloader bytes into the application slot:
 * the CRC check passes, the header is stamped, and the device jumps into
 * garbage — bricked until someone attaches a programmer. A source's
 * `rejectPattern` can add to this floor; nothing can remove it.
 */
const REJECT_FLOOR = /(merged|bootloader)/i;

/** Upper bound on an application image, as a sanity check before flashing. */
const MAX_IMAGE_BYTES = 256 * 1024;

/** Pages of 100 releases read per repository (500 releases). */
const MAX_RELEASE_PAGES = 5;

/** Wall-clock ceiling on one image download, on top of the socket idle timeout. */
const DOWNLOAD_DEADLINE_MS = 10 * 60 * 1000;

interface GitHubAsset {
  name?: string;
  url?: string;
  browser_download_url?: string;
  size?: number;
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubAsset[];
}

export interface CatalogOptions {
  channel: Channel;
  /** Configured source per device class. A missing entry means "not configured". */
  sources: Partial<Record<TargetKind, FirmwareSourceConfig>>;
  /** Credential with read access to private firmware repositories. */
  token: Secret | null;
  /** Version of this CLI, used to honour a `dir` release's `min_cli_version`. */
  cliVersion: Version;
  /**
   * compatibility.json as loaded for this run. Required for `github` sources:
   * absent, null or without a document, nothing is offered from GitHub.
   */
  compat?: CompatLoad | null;
  /**
   * What is installed — this CLI, the interface boards, the docked packs —
   * for the consumer rule. Pack images need the board versions in here.
   */
  installed?: InstalledComponent[];
  /** Where downloaded images live between runs. */
  cacheDir: string;
  /** Images kept per device class after a download; older ones are pruned. */
  cacheKeepPerKind: number;
  /** Collected non-fatal problems, appended in place. */
  warnings: string[];
  /**
   * Reads a GitHub release's legacy CLI floor (`metadata.json`
   * `min_cli_version`, null when it declares none), for a legacy release
   * never tested with this CLI. Defaults to downloading that asset; tests
   * inject it.
   */
  legacyMinCli?: (release: GitHubRelease, repo: string, opts: CatalogOptions) => Promise<Version | null>;
}

/** The accept/reject pair actually applied for a source. */
export function assetRules(kind: TargetKind, source: FirmwareSourceConfig | undefined) {
  const accept = new RegExp(source?.assetPattern ?? DEFAULT_ACCEPT[kind], "i");
  const extraReject = source?.rejectPattern ? new RegExp(source.rejectPattern, "i") : null;
  return {
    accepts: (name: string) =>
      accept.test(name) && !REJECT_FLOOR.test(name) && !(extraReject?.test(name) ?? false),
    describe: source?.assetPattern ?? DEFAULT_ACCEPT[kind],
  };
}

/**
 * Returns the newest release for `kind` that is eligible on the channel and
 * compatible with this CLI, or null when there is nothing to offer (including
 * when no source is configured — the planner reports that as NO_SOURCE).
 */
export async function resolveCandidate(
  kind: TargetKind,
  opts: CatalogOptions
): Promise<ReleaseCandidate | null> {
  const source = opts.sources[kind];
  if (!source) return null;
  if (source.provider === "dir") return resolveLocalCandidate(kind, source, opts);

  const repo = source.repo ?? "";

  // Every page, not only the first: the listing is ordered by creation date,
  // not by version, so a patch release of an older line can sit on page 2.
  let releases: GitHubRelease[] = [];
  try {
    for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
      const url = `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`;
      const batch = await httpGetJson<GitHubRelease[]>(url, { token: opts.token });
      if (!Array.isArray(batch)) {
        releases = batch as unknown as GitHubRelease[];
        break;
      }
      releases = releases.concat(batch);
      if (batch.length < 100) break;
    }
  } catch (e) {
    const hint =
      e instanceof HttpError && (e.statusCode === 401 || e.statusCode === 404)
        ? " (private repository? check credentials.github.token)"
        : "";
    opts.warnings.push(
      `Cannot list releases for ${repo}: ${e instanceof Error ? e.message : String(e)}${hint}`
    );
    return null;
  }

  if (!Array.isArray(releases)) {
    opts.warnings.push(`Unexpected releases payload for ${repo}`);
    return null;
  }

  return selectGithubCandidate(kind, source, releases, opts);
}

/**
 * Picks the release to offer from a GitHub releases listing. Pure apart from
 * appending to `opts.warnings` and reading a legacy release's metadata.json
 * (`opts.legacyMinCli`), so the selection is tested from fixtures.
 */
export async function selectGithubCandidate(
  kind: TargetKind,
  source: FirmwareSourceConfig,
  releases: GitHubRelease[],
  opts: CatalogOptions
): Promise<ReleaseCandidate | null> {
  const repo = source.repo ?? "";
  const component = COMPONENT_OF[kind];
  const doc = opts.compat?.doc ?? null;
  if (!doc) {
    opts.warnings.push(
      `no compatibility data, so no ${kind} firmware is offered from ${repo} ` +
        `(fail closed: station-cli installs only releases compatibility.json lists as compatible)`
    );
    return null;
  }
  const listed = doc.components[component]?.repo;
  if (listed && listed.toLowerCase() !== repo.toLowerCase()) {
    opts.warnings.push(
      `compatibility.json describes ${component} releases of ${listed}, but firmware.sources.${kind} ` +
        `reads ${repo} — no ${kind} firmware is offered`
    );
    return null;
  }

  const installed = opts.installed ?? [];
  if (kind === "powerbank" && !installed.some((i) => i.component === COMPONENT_OF.interface)) {
    opts.warnings.push(
      "no interface board firmware version could be read, and a powerbank image is only offered " +
        "when every board it may be docked in is compatible with it — no powerbank firmware is offered"
    );
    return null;
  }

  // The floors of this station's channel: a stable station installs only
  // production releases, so a failing dev release of another component does
  // not hold it back; a beta one may install either, and uses both.
  const channel = stationChannel(opts.channel);
  const rules = assetRules(kind, source);
  const eligible = releases
    .filter((r) => r && r.draft !== true)
    .map((r) => ({ release: r, classified: classifyTag(component, r.tag_name ?? "") }))
    .filter(
      (e): e is { release: GitHubRelease; classified: NonNullable<ReturnType<typeof classifyTag>> } =>
        e.classified !== null
    )
    // The channel is read from the tag, never from GitHub's prerelease flag.
    .filter((e) => (opts.channel === "stable" ? e.classified.channel === "production" : true))
    // Newest first in SemVer order (dev-v3.2.0 < v3.2.0), so the first
    // installable hit is the best one.
    .sort((a, b) => compareSemVer(b.classified.version, a.classified.version));

  const skipped: string[] = [];
  const flushSkipped = () => {
    for (const line of skipped.slice(0, SKIP_DETAIL_LIMIT)) opts.warnings.push(line);
    if (skipped.length > SKIP_DETAIL_LIMIT) {
      opts.warnings.push(
        `… and ${skipped.length - SKIP_DETAIL_LIMIT} older ${component} release(s) of ${repo} skipped for the same reasons`
      );
    }
  };

  for (const entry of eligible) {
    const tag = entry.classified.tag;
    const asset = (entry.release.assets ?? []).find((a) => !!a.name && rules.accepts(a.name));
    if (!asset || !asset.name) {
      skipped.push(`Release ${tag} of ${repo} has no asset matching ${rules.describe} — skipping.`);
      continue;
    }
    const verdict = checkInstall(doc, component, tag, installed, { channel });
    if (!verdict.installable) {
      skipped.push(`Release ${tag} of ${repo} is not installable here: ${verdict.reasons.join("; ")} — skipping.`);
      continue;
    }
    // Prefer the API asset URL: it works for private repositories with a
    // token, whereas browser_download_url needs the release to be public.
    const assetUrl = asset.url ?? asset.browser_download_url;
    if (!assetUrl) {
      skipped.push(`Asset ${asset.name} of ${tag} has no download URL — skipping.`);
      continue;
    }
    // A legacy release never tested with this CLI: its own metadata.json
    // floor decides, as it did before compatibility.json.
    let minCliVersion: Version | null;
    if (verdict.untestedLegacy.includes("station_cli")) {
      minCliVersion = await (opts.legacyMinCli ?? readMinCliVersion)(entry.release, repo, opts);
      if (minCliVersion && !isAtLeast(opts.cliVersion, minCliVersion)) {
        skipped.push(
          `Release ${tag} of ${repo} (legacy, never tested with this station-cli) needs station-cli >= ` +
            `${formatVersion(minCliVersion)} per its metadata.json, running ${formatVersion(opts.cliVersion)} — skipping.`
        );
        continue;
      }
    } else {
      const cliFloor = parseSemVer(
        channelFloor(doc.components[component]?.releases[tag]?.requires.station_cli, channel)?.min ?? null
      );
      minCliVersion = cliFloor ? [cliFloor.major, cliFloor.minor, cliFloor.patch] : null;
    }
    flushSkipped();
    for (const note of verdict.notes) opts.warnings.push(`compatibility: ${note}`);

    const v = entry.classified.version;
    return {
      kind,
      tag,
      version: [v.major, v.minor, v.patch],
      prerelease: entry.classified.channel === "development",
      assetName: asset.name,
      assetUrl,
      assetSizeBytes: asset.size ?? 0,
      minCliVersion,
      digest: asset.digest ?? null,
      compat: {
        sequence: doc.sequence,
        origin: opts.compat?.origin ?? "none",
        requires: doc.components[component]?.releases[tag]?.requires ?? {},
        legacy: verdict.legacy,
        untestedLegacy: verdict.untestedLegacy,
      },
    };
  }

  flushSkipped();
  return null;
}

/**
 * The `dir` provider: a local folder laid out like a set of releases, so a
 * firmware build can go through the exact production path — channel filter,
 * CLI floor from `metadata.json`, version gates, cache, flash, read-back —
 * on the emulator or a bench station before it is published.
 *
 * Accepted layouts, mixable:
 *   <path>/<tag>/<asset>.bin [+ metadata.json] [+ PRERELEASE]
 *   <path>/<asset>.bin                         (tag `v<version from name>`)
 */
async function resolveLocalCandidate(
  kind: TargetKind,
  source: FirmwareSourceConfig,
  opts: CatalogOptions
): Promise<ReleaseCandidate | null> {
  const root = source.path ?? "";
  const rules = assetRules(kind, source);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (e) {
    opts.warnings.push(
      `Cannot read firmware folder ${root}: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }

  interface LocalRelease {
    tag: string;
    version: Version;
    prerelease: boolean;
    dir: string;
    asset: string;
  }
  const found: LocalRelease[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      const dir = path.join(root, e.name);
      const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
      const asset = files.find((f) => rules.accepts(f));
      const version = parseVersion(versionStringFromTag(e.name));
      if (!version) continue;
      if (!asset) {
        opts.warnings.push(`Release ${e.name} in ${root} has no asset matching ${rules.describe} — skipping.`);
        continue;
      }
      found.push({
        tag: e.name,
        version,
        prerelease: e.name.startsWith("dev-") || files.includes("PRERELEASE"),
        dir,
        asset,
      });
    } else if (e.isFile() && rules.accepts(e.name)) {
      const m = /(\d+\.\d+(?:\.\d+)?)/.exec(e.name);
      const version = m ? parseVersion(m[1]) : null;
      if (!version) continue;
      found.push({ tag: `v${formatVersion(version)}`, version, prerelease: false, dir: root, asset: e.name });
    }
  }

  const eligible = found
    .filter((r) => (opts.channel === "stable" ? !r.prerelease : true))
    .sort((a, b) => compareVersions(b.version, a.version));

  for (const r of eligible) {
    const minCliVersion = await readLocalMinCliVersion(r.dir, r.tag, opts);
    if (minCliVersion && !isAtLeast(opts.cliVersion, minCliVersion)) {
      opts.warnings.push(
        `Release ${r.tag} in ${root} needs station-cli >= ${formatVersion(minCliVersion)}, ` +
          `running ${formatVersion(opts.cliVersion)} — skipping.`
      );
      continue;
    }
    const file = path.join(r.dir, r.asset);
    const stat = await fs.promises.stat(file);
    return {
      kind,
      tag: r.tag,
      version: r.version,
      prerelease: r.prerelease,
      assetName: r.asset,
      assetUrl: `file://${file}`,
      assetSizeBytes: stat.size,
      minCliVersion,
      digest: null,
    };
  }
  return null;
}

async function readLocalMinCliVersion(
  dir: string,
  tag: string,
  opts: CatalogOptions
): Promise<Version | null> {
  const file = path.join(dir, "metadata.json");
  let body: string;
  try {
    body = await fs.promises.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const raw = (JSON.parse(body) as Record<string, unknown>).min_cli_version;
    if (typeof raw !== "string") return null;
    const parsed = parseVersion(raw);
    if (!parsed) {
      opts.warnings.push(`metadata.json of ${tag} has unparseable min_cli_version "${raw}" — ignoring.`);
    }
    return parsed;
  } catch (e) {
    opts.warnings.push(
      `Cannot read metadata.json of ${tag}: ${e instanceof Error ? e.message : String(e)} — assuming no CLI floor.`
    );
    return null;
  }
}

/**
 * Reads `min_cli_version` from a GitHub release's `metadata.json` asset: the
 * legacy CLI floor, still published (computed, and never raised without a
 * tested failure) for CLIs that predate compatibility.json. Absent asset or
 * field means "no declared floor"; an unreadable one is warned about and
 * treated the same, as the catalog always did.
 */
async function readMinCliVersion(
  release: GitHubRelease,
  repo: string,
  opts: CatalogOptions
): Promise<Version | null> {
  const asset = (release.assets ?? []).find((a) => a.name === "metadata.json");
  const url = asset?.url ?? asset?.browser_download_url;
  if (!url) return null;
  try {
    const body = await httpGetBuffer(url, {
      token: opts.token,
      accept: "application/octet-stream",
      timeoutMs: 15_000,
    });
    const raw = (JSON.parse(body.toString("utf8")) as Record<string, unknown>).min_cli_version;
    if (typeof raw !== "string") return null;
    const parsed = parseVersion(raw);
    if (!parsed) {
      opts.warnings.push(
        `metadata.json of ${release.tag_name} (${repo}) has unparseable min_cli_version "${raw}" — ignoring.`
      );
    }
    return parsed;
  } catch (e) {
    opts.warnings.push(
      `Cannot read metadata.json of ${release.tag_name} (${repo}): ` +
        `${e instanceof Error ? e.message : String(e)} — assuming no CLI floor.`
    );
    return null;
  }
}

/** Cache file name for a candidate. The kind prefix scopes pruning. */
function cacheFileName(c: ReleaseCandidate): string {
  return `${c.kind}-${c.tag}-${c.assetName}`;
}

/**
 * Ensures the candidate's image is in the cache and returns its path.
 *
 * A cached file is reused only when its size — and digest, when GitHub
 * reports one — matches. Anything else is re-downloaded: a stale or truncated
 * image that passed the bootloader's CRC by coincidence is exactly the
 * failure mode that bricks a board. After a successful fetch, older images of
 * the same device class are pruned.
 */
export async function ensureImage(
  candidate: ReleaseCandidate,
  opts: CatalogOptions
): Promise<string> {
  await fs.promises.mkdir(opts.cacheDir, { recursive: true });
  const cachePath = path.join(opts.cacheDir, cacheFileName(candidate));
  const digest = candidate.digest;

  if (await imageIsIntact(cachePath, candidate.assetSizeBytes, digest)) {
    await pruneCache(opts.cacheDir, candidate.kind, opts.cacheKeepPerKind, cachePath);
    return cachePath;
  }

  await fs.promises.rm(cachePath, { force: true });
  let written: number;
  if (candidate.assetUrl.startsWith("file://")) {
    // `dir` provider: copied through a .part file like a download, so a
    // half-copied image can never be mistaken for a cached one.
    const part = `${cachePath}.part`;
    await fs.promises.copyFile(candidate.assetUrl.slice("file://".length), part);
    await fs.promises.rename(part, cachePath);
    written = (await fs.promises.stat(cachePath)).size;
  } else {
    written = await httpDownloadToFile(candidate.assetUrl, cachePath, {
      token: opts.token,
      accept: "application/octet-stream",
      timeoutMs: 120_000,
      deadlineMs: DOWNLOAD_DEADLINE_MS,
    });
  }

  const refuse = async (why: string): Promise<never> => {
    await fs.promises.rm(cachePath, { force: true });
    throw new Error(why);
  };
  if (candidate.assetSizeBytes > 0 && written !== candidate.assetSizeBytes) {
    await refuse(
      `Downloaded ${candidate.assetName} is ${written} B but GitHub reported ` +
        `${candidate.assetSizeBytes} B — refusing to flash a partial image.`
    );
  }
  if (written === 0) {
    await refuse(`Downloaded ${candidate.assetName} is empty — refusing to flash.`);
  }
  if (written > MAX_IMAGE_BYTES) {
    await refuse(
      `Downloaded ${candidate.assetName} is ${written} B, above the ${MAX_IMAGE_BYTES} B ` +
        `sanity limit — refusing to flash (wrong asset?).`
    );
  }
  if (digest && !(await digestMatches(cachePath, digest))) {
    await refuse(
      `Downloaded ${candidate.assetName} does not match the digest GitHub reported — refusing to flash.`
    );
  }

  await pruneCache(opts.cacheDir, candidate.kind, opts.cacheKeepPerKind, cachePath);
  return cachePath;
}

/**
 * Keeps `keep` images of one device class — always including `protect`, the
 * image just resolved, whatever its age — and deletes the rest, oldest first.
 *
 * The in-use image is not necessarily the newest: a cached image is reused
 * without touching its mtime, and a rollback resolves an older release. It is
 * counted inside the budget rather than on top of it, so the cache never holds
 * more than `keep` images per class. Best-effort: a failure to prune never
 * fails the run, it only costs disk.
 */
export async function pruneCache(
  cacheDir: string,
  kind: TargetKind,
  keep: number,
  protect: string
): Promise<string[]> {
  const removed: string[] = [];
  try {
    const entries = await fs.promises.readdir(cacheDir);
    const mine = entries.filter((n) => n.startsWith(`${kind}-`) && !n.endsWith(".part"));
    const withTimes = await Promise.all(
      mine.map(async (n) => {
        const p = path.join(cacheDir, n);
        return { p, mtime: (await fs.promises.stat(p)).mtimeMs };
      })
    );
    const protectedPath = path.resolve(protect);
    const others = withTimes
      .filter((e) => path.resolve(e.p) !== protectedPath)
      .sort((a, b) => b.mtime - a.mtime);
    // One slot of the budget is always the protected image.
    for (const e of others.slice(Math.max(0, Math.max(1, keep) - 1))) {
      await fs.promises.rm(e.p, { force: true });
      removed.push(e.p);
    }
  } catch {
    // best-effort by design
  }
  return removed;
}

async function imageIsIntact(
  filePath: string,
  expectedSize: number,
  digest: string | null
): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size === 0) return false;
  if (expectedSize > 0 && stat.size !== expectedSize) return false;
  if (digest) return digestMatches(filePath, digest);
  return true;
}

/** Verifies a `sha256:<hex>` digest as returned by the GitHub Releases API. */
async function digestMatches(filePath: string, digest: string): Promise<boolean> {
  const [algo, expected] = digest.split(":");
  if (!algo || !expected) return true; // unknown format — do not block on it
  let hash: crypto.Hash;
  try {
    hash = crypto.createHash(algo);
  } catch {
    return true; // unsupported algorithm — do not block on it
  }
  const actual = hash.update(await fs.promises.readFile(filePath)).digest("hex");
  return actual.toLowerCase() === expected.toLowerCase();
}
