import * as fs from "node:fs";
import * as path from "node:path";

import { httpGetBuffer, httpGetJson, HttpError } from "../S1TTXX/fwu/http";
import { Secret } from "../config/secret";
import { CompatSourceConfig } from "../config/schema";
import { CompatibilityDoc, parseCompatibility } from "./compatibility";

/**
 * Where compatibility.json comes from, in order (rule 4 of the consumer rule):
 *
 *   1. the published file — `compat.asset` of release `compat.tag` in
 *      `compat.repo`, read with credentials.github.token;
 *   2. the on-disk cache of the last good copy;
 *   3. the copy bundled into this binary by CI at build time;
 *   4. nothing — and then no firmware is installed from GitHub (fail closed).
 *
 * A copy with a lower `sequence` than another valid one is never preferred:
 * release-compatibility-cli numbers its publications monotonically, so a lower number is
 * a stale read, not a correction.
 */

export type CompatOrigin = "network" | "cache" | "bundled" | "none";

export interface CompatLoad {
  doc: CompatibilityDoc | null;
  origin: CompatOrigin;
  /** Where it was read from: a URL-like `repo@tag/asset`, or a file path. */
  location: string | null;
  sequence: number | null;
  generatedAt: string | null;
  /** Why the published copy was not used, when it was not. */
  error: string | null;
}

/** Fetches the raw bytes of the published file. Injected in tests. */
export type CompatFetcher = (source: CompatSourceConfig, token: Secret | null) => Promise<Buffer>;

export interface CompatLoadOptions {
  source: CompatSourceConfig;
  token: Secret | null;
  cacheFile: string;
  /** The build-time copy; null when this binary carries none. */
  bundledFile: string | null;
  fetch?: CompatFetcher;
  /** Collected non-fatal problems, appended in place. */
  warnings: string[];
}

interface GitHubReleaseAssets {
  assets?: Array<{ name?: string; url?: string; browser_download_url?: string }>;
}

/** The GitHub implementation: release by tag, then its asset through the API URL. */
export const githubCompatFetcher: CompatFetcher = async (source, token) => {
  const release = await httpGetJson<GitHubReleaseAssets>(
    `https://api.github.com/repos/${source.repo}/releases/tags/${encodeURIComponent(source.tag)}`,
    { token, timeoutMs: 15_000, deadlineMs: 30_000 }
  );
  const asset = (release.assets ?? []).find((a) => a.name === source.asset);
  const url = asset?.url ?? asset?.browser_download_url;
  if (!url) throw new Error(`release ${source.tag} of ${source.repo} has no asset ${source.asset}`);
  return httpGetBuffer(url, {
    token,
    accept: "application/octet-stream",
    timeoutMs: 15_000,
    deadlineMs: 60_000,
  });
};

function describe(source: CompatSourceConfig): string {
  return `${source.repo}@${source.tag}/${source.asset}`;
}

function readFileDoc(file: string | null, what: string, warnings: string[]): CompatibilityDoc | null {
  if (!file) return null;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null; // absent: the normal case for a cache that was never written
  }
  const parsed = parseCompatibility(text);
  if (!parsed.doc) {
    warnings.push(`ignoring the ${what} compatibility.json (${file}): ${parsed.errors.slice(0, 3).join("; ")}`);
  }
  return parsed.doc;
}

function writeCache(file: string, body: Buffer, warnings: string[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (e) {
    warnings.push(`could not cache compatibility.json at ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const loaded = (doc: CompatibilityDoc, origin: CompatOrigin, location: string, error: string | null): CompatLoad => ({
  doc,
  origin,
  location,
  sequence: doc.sequence,
  generatedAt: doc.generated_at ?? null,
  error,
});

export async function loadCompatibility(opts: CompatLoadOptions): Promise<CompatLoad> {
  const fetcher = opts.fetch ?? githubCompatFetcher;
  let error: string | null = null;
  let fresh: CompatibilityDoc | null = null;
  let freshBody: Buffer | null = null;

  try {
    freshBody = await fetcher(opts.source, opts.token);
    const parsed = parseCompatibility(freshBody.toString("utf8"));
    if (parsed.doc) fresh = parsed.doc;
    else error = `published compatibility.json is invalid: ${parsed.errors.slice(0, 3).join("; ")}`;
  } catch (e) {
    const hint =
      e instanceof HttpError && (e.statusCode === 401 || e.statusCode === 403 || e.statusCode === 404)
        ? " (private repository? check credentials.github.token)"
        : "";
    error = `cannot read ${describe(opts.source)}: ${e instanceof Error ? e.message : String(e)}${hint}`;
  }

  const cached = readFileDoc(opts.cacheFile, "cached", opts.warnings);

  if (fresh && freshBody) {
    if (cached && cached.sequence > fresh.sequence) {
      opts.warnings.push(
        `published compatibility.json is sequence ${fresh.sequence}, older than the cached ${cached.sequence} — using the cache`
      );
      return loaded(cached, "cache", opts.cacheFile, `published copy is stale (sequence ${fresh.sequence})`);
    }
    writeCache(opts.cacheFile, freshBody, opts.warnings);
    return loaded(fresh, "network", describe(opts.source), null);
  }

  const bundled = readFileDoc(opts.bundledFile, "bundled", opts.warnings);
  const fallbacks: Array<[CompatibilityDoc, CompatOrigin, string]> = [];
  if (cached) fallbacks.push([cached, "cache", opts.cacheFile]);
  if (bundled && opts.bundledFile) fallbacks.push([bundled, "bundled", opts.bundledFile]);
  fallbacks.sort((a, b) => b[0].sequence - a[0].sequence);
  if (fallbacks.length) {
    const [doc, origin, location] = fallbacks[0];
    opts.warnings.push(`${error}; using the ${origin} compatibility.json (sequence ${doc.sequence})`);
    return loaded(doc, origin, location, error);
  }

  opts.warnings.push(
    `${error}; no cached or bundled compatibility.json either — no firmware will be installed from GitHub until it can be read`
  );
  return { doc: null, origin: "none", location: null, sequence: null, generatedAt: null, error };
}
