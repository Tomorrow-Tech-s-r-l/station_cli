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

/**
 * Resolves which firmware build each device class *should* be running, from
 * the GitHub Releases of the repository configured for it, and keeps the
 * downloaded images in a verified on-disk cache.
 *
 * Where firmware comes from is configuration (`firmware.sources`), never
 * source code: this binary is published and carries no deployment knowledge.
 *
 * The release walk mirrors the kiosk app's own updater: channel-filtered,
 * newest first, a `metadata.json` asset carrying a CLI version floor, and
 * "no metadata" meaning "compatible with everything".
 */

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

/** Wall-clock ceiling on one image download, on top of the socket idle timeout. */
const DOWNLOAD_DEADLINE_MS = 10 * 60 * 1000;

interface GitHubAsset {
  name?: string;
  url?: string;
  browser_download_url?: string;
  size?: number;
  digest?: string | null;
}

interface GitHubRelease {
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
  /** Version of this CLI, used to honour a release's `min_cli_version`. */
  cliVersion: Version;
  /** Where downloaded images live between runs. */
  cacheDir: string;
  /** Images kept per device class after a download; older ones are pruned. */
  cacheKeepPerKind: number;
  /** Collected non-fatal problems, appended in place. */
  warnings: string[];
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

  const repo = source.repo;
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;

  let releases: GitHubRelease[];
  try {
    releases = await httpGetJson<GitHubRelease[]>(url, { token: opts.token });
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

  const rules = assetRules(kind, source);
  const eligible = releases
    .filter((r) => r && r.draft !== true)
    .filter((r) => (opts.channel === "stable" ? r.prerelease !== true : true))
    .map((r) => {
      const tag = (r.tag_name ?? "").trim();
      return { release: r, tag, version: parseVersion(versionStringFromTag(tag)) };
    })
    .filter(
      (e): e is { release: GitHubRelease; tag: string; version: Version } =>
        e.version !== null && e.tag.length > 0
    )
    // Newest first, so the first compatible hit is the best one.
    .sort((a, b) => compareVersions(b.version, a.version));

  for (const entry of eligible) {
    const asset = (entry.release.assets ?? []).find((a) => !!a.name && rules.accepts(a.name));
    if (!asset || !asset.name) {
      opts.warnings.push(
        `Release ${entry.tag} of ${repo} has no asset matching ${rules.describe} — skipping.`
      );
      continue;
    }

    const minCliVersion = await readMinCliVersion(entry.release, repo, opts);
    if (minCliVersion && !isAtLeast(opts.cliVersion, minCliVersion)) {
      opts.warnings.push(
        `Release ${entry.tag} of ${repo} needs station-cli >= ${formatVersion(minCliVersion)}, ` +
          `running ${formatVersion(opts.cliVersion)} — skipping.`
      );
      continue;
    }

    // Prefer the API asset URL: it works for private repositories with a
    // token, whereas browser_download_url needs the release to be public.
    const assetUrl = asset.url ?? asset.browser_download_url;
    if (!assetUrl) {
      opts.warnings.push(`Asset ${asset.name} of ${entry.tag} has no download URL — skipping.`);
      continue;
    }

    return {
      kind,
      tag: entry.tag,
      version: entry.version,
      prerelease: entry.release.prerelease === true,
      assetName: asset.name,
      assetUrl,
      assetSizeBytes: asset.size ?? 0,
      minCliVersion,
      digest: asset.digest ?? null,
    };
  }

  return null;
}

/**
 * Reads `min_cli_version` from the release's `metadata.json` asset. Absent
 * asset or field means "no declared floor".
 */
async function readMinCliVersion(
  release: GitHubRelease,
  repo: string,
  opts: CatalogOptions
): Promise<Version | null> {
  const asset = (release.assets ?? []).find((a) => a.name === "metadata.json");
  if (!asset) return null;
  const url = asset.url ?? asset.browser_download_url;
  if (!url) return null;
  try {
    const body = await httpGetBuffer(url, {
      token: opts.token,
      accept: "application/octet-stream",
      timeoutMs: 15_000,
    });
    const meta = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    const raw = meta.min_cli_version;
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
  const written = await httpDownloadToFile(candidate.assetUrl, cachePath, {
    token: opts.token,
    accept: "application/octet-stream",
    timeoutMs: 120_000,
    deadlineMs: DOWNLOAD_DEADLINE_MS,
  });

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
