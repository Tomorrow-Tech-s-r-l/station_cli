import * as fs from "node:fs";
import * as os from "node:os";
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

/**
 * Resolves which firmware build each device class *should* be running, by
 * reading the GitHub Releases of the two firmware repositories, and caches the
 * downloaded images on disk.
 *
 * This mirrors the kiosk app's `StationCliAutoUpdateService`: channel-filtered
 * release list, newest-first walk, a `metadata.json` asset carrying the
 * compatibility floor, and "missing metadata means compatible with everything"
 * so releases predating the feature keep working.
 */

/** Repositories that publish flashable images, one per device class. */
const FIRMWARE_REPOS: Record<TargetKind, string> = {
  interface: "Tomorrow-Tech-s-r-l/S1TTXX-firmware",
  powerbank: "Tomorrow-Tech-s-r-l/P1TT2C-firmware",
};

/**
 * Asset selectors, per device class.
 *
 * `accept` must match the **application-only** raw binary and nothing else.
 * This is the single most safety-critical rule in the catalog: both repos also
 * publish a `merged` image (bootloader + header + app, linked at 0x08000000)
 * for SWD bring-up of a blank MCU. Streaming a merged image through the
 * firmware-update path would write bootloader bytes into the application slot
 * — the CRC check would pass, the header would be stamped, and the board would
 * jump into garbage and brick until someone attaches a programmer. The
 * `reject` pattern is therefore belt-and-braces on top of `accept`.
 */
const ASSET_RULES: Record<
  TargetKind,
  { accept: RegExp; reject: RegExp; describe: string }
> = {
  interface: {
    accept: /^S1TTXX-firmware-[0-9][^/]*\.bin$/i,
    reject: /(merged|bootloader)/i,
    describe: "S1TTXX-firmware-<version>.bin",
  },
  powerbank: {
    accept: /^P1TT2C-firmware-[0-9][^/]*\.bin$/i,
    reject: /(merged|bootloader)/i,
    describe: "P1TT2C-firmware-<version>.bin",
  },
};

/** Upper bound on an application image, as a sanity check before flashing. */
const MAX_IMAGE_BYTES = 256 * 1024;

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
  /** Token with read access to the private firmware repos. */
  token: string | null;
  /** Version of this CLI, used to honour a release's `min_cli_version`. */
  cliVersion: Version;
  /** Where downloaded images live between runs. */
  cacheDir: string;
  /** Collected non-fatal problems, appended in place. */
  warnings: string[];
}

/** Default cache location; override with `--cache-dir` or `AMPERRY_FWU_CACHE_DIR`. */
export function defaultCacheDir(): string {
  const fromEnv = process.env.AMPERRY_FWU_CACHE_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.homedir(), ".amperry", "firmware");
}

/** Reads the token from the flag, then the usual environment variables. */
export function resolveToken(explicit?: string | null): string | null {
  const candidates = [
    explicit,
    process.env.AMPERRY_FWU_GITHUB_TOKEN,
    process.env.GITHUB_TOKEN,
    process.env.GH_TOKEN,
  ];
  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }
  return null;
}

/**
 * Returns the newest release for `kind` that is eligible on `channel` and
 * compatible with this CLI, or null when there is nothing to offer.
 *
 * "Eligible" means: not a draft, tag parses as a version, carries the
 * application-only `.bin` asset, and — on the `stable` channel — is not a
 * pre-release. Releases whose `min_cli_version` exceeds the running CLI are
 * walked past rather than failing the whole run, so a fleet on mixed CLI
 * versions converges instead of stalling.
 */
export async function resolveCandidate(
  kind: TargetKind,
  opts: CatalogOptions
): Promise<ReleaseCandidate | null> {
  const repo = FIRMWARE_REPOS[kind];
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;

  let releases: GitHubRelease[];
  try {
    releases = await httpGetJson<GitHubRelease[]>(url, { token: opts.token });
  } catch (e) {
    const hint =
      e instanceof HttpError && (e.statusCode === 401 || e.statusCode === 404)
        ? " (private repo — is GITHUB_TOKEN set and scoped to it?)"
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

  const eligible = releases
    .filter((r) => r && r.draft !== true)
    .filter((r) => (opts.channel === "stable" ? r.prerelease !== true : true))
    .map((r) => {
      const tag = (r.tag_name ?? "").trim();
      const version = parseVersion(versionStringFromTag(tag));
      return { release: r, tag, version };
    })
    .filter(
      (e): e is { release: GitHubRelease; tag: string; version: Version } =>
        e.version !== null && e.tag.length > 0
    )
    // Newest first, so the first compatible hit is the best one.
    .sort((a, b) => compareVersions(b.version, a.version));

  for (const entry of eligible) {
    const rule = ASSET_RULES[kind];
    const assets = entry.release.assets ?? [];
    const asset = assets.find(
      (a) => !!a.name && rule.accept.test(a.name) && !rule.reject.test(a.name)
    );
    if (!asset || !asset.name) {
      opts.warnings.push(
        `Release ${entry.tag} of ${repo} has no ${rule.describe} asset — skipping.`
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

    // Prefer the API asset URL: it works for private repos with a token,
    // whereas browser_download_url needs the release to be public.
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
      // `digest` is carried through the cache check below but is not part of
      // the public candidate shape, so stash it on the object non-visibly.
      ...(asset.digest ? { __digest: asset.digest } : {}),
    } as ReleaseCandidate;
  }

  return null;
}

/**
 * Reads `min_cli_version` from the release's `metadata.json` asset.
 *
 * Returns null when the asset is absent or the field is missing — both mean
 * "no declared floor", i.e. compatible with every CLI, matching how the kiosk
 * treats CLI releases that predate its own metadata.json.
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

/**
 * Ensures the candidate's image is in the cache and returns its path.
 *
 * A cached file is reused only when its size matches the size GitHub reported
 * (and its SHA-256 matches, when the API supplied a digest). Anything else is
 * re-downloaded: a stale or truncated image that passes the bootloader's CRC
 * check by coincidence is exactly the failure mode that bricks a board.
 */
export async function ensureImage(
  candidate: ReleaseCandidate,
  opts: CatalogOptions
): Promise<string> {
  await fs.promises.mkdir(opts.cacheDir, { recursive: true });
  const cachePath = path.join(
    opts.cacheDir,
    `${candidate.kind}-${candidate.tag}-${candidate.assetName}`
  );
  const digest = (candidate as unknown as { __digest?: string }).__digest ?? null;

  if (await imageIsIntact(cachePath, candidate.assetSizeBytes, digest)) {
    return cachePath;
  }

  await fs.promises.rm(cachePath, { force: true });
  const written = await httpDownloadToFile(candidate.assetUrl, cachePath, {
    token: opts.token,
    accept: "application/octet-stream",
    timeoutMs: 120_000,
  });

  if (candidate.assetSizeBytes > 0 && written !== candidate.assetSizeBytes) {
    await fs.promises.rm(cachePath, { force: true });
    throw new Error(
      `Downloaded ${candidate.assetName} is ${written} B but GitHub reported ` +
        `${candidate.assetSizeBytes} B — refusing to flash a partial image.`
    );
  }
  if (written === 0) {
    await fs.promises.rm(cachePath, { force: true });
    throw new Error(`Downloaded ${candidate.assetName} is empty — refusing to flash.`);
  }
  if (written > MAX_IMAGE_BYTES) {
    await fs.promises.rm(cachePath, { force: true });
    throw new Error(
      `Downloaded ${candidate.assetName} is ${written} B, above the ${MAX_IMAGE_BYTES} B ` +
        `sanity limit — refusing to flash (wrong asset?).`
    );
  }
  if (digest && !(await digestMatches(cachePath, digest))) {
    await fs.promises.rm(cachePath, { force: true });
    throw new Error(
      `Downloaded ${candidate.assetName} does not match the digest GitHub reported — refusing to flash.`
    );
  }

  return cachePath;
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
