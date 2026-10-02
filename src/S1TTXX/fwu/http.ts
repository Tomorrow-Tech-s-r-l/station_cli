import * as https from "node:https";
import * as fs from "node:fs";
import { URL } from "node:url";

import { Secret } from "../../config/secret";

/**
 * Minimal HTTPS helpers for the firmware catalog.
 *
 * Deliberately built on `node:https` rather than global `fetch`: the CLI ships
 * as a `pkg` binary targeting node18, and keeping to the classic core module
 * avoids depending on how the snapshot bundles undici. No new npm dependency
 * either, which matters for a binary that runs unattended on stations.
 */

const USER_AGENT = "amperry-station-cli";
const MAX_REDIRECTS = 5;

export interface HttpOptions {
  /**
   * GitHub credential. Sent only to GitHub's own API hosts, and revealed only
   * at the moment the header is built. A plain string is accepted for tests.
   */
  token?: Secret | string | null;
  /** Value for the Accept header. */
  accept?: string;
  /** Socket idle timeout: fires when no bytes arrive for this long. */
  timeoutMs?: number;
  /**
   * Wall-clock ceiling on the whole request, redirects included. The idle
   * timeout alone cannot stop a link that trickles a byte every few seconds
   * forever; this can.
   */
  deadlineMs?: number;
}

function tokenValue(token: HttpOptions["token"]): string | null {
  if (!token) return null;
  return typeof token === "string" ? token : token.reveal();
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly url: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * True for hosts we are willing to send the GitHub token to.
 *
 * Release-asset downloads redirect to an object store (`objects.githubusercontent.com`,
 * or an S3 bucket) with the credentials already baked into the signed URL.
 * Forwarding `Authorization` there is both unnecessary and harmful — S3 rejects
 * a request carrying two competing auth mechanisms with 400 — so the token is
 * scoped to GitHub's own API hosts and dropped on every other hop.
 */
export function isGitHubApiHost(hostname: string): boolean {
  return hostname === "api.github.com" || hostname === "github.com";
}

interface RawResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function request(
  url: string,
  opts: HttpOptions,
  redirectsLeft: number,
  sink?: fs.WriteStream
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Malformed URL: ${url}`));
      return;
    }
    if (parsed.protocol !== "https:") {
      reject(new Error(`Refusing non-HTTPS firmware URL: ${url}`));
      return;
    }

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: opts.accept ?? "application/vnd.github+json",
    };
    const token = tokenValue(opts.token);
    if (token && isGitHubApiHost(parsed.hostname)) {
      headers.Authorization = `Bearer ${token}`;
    }

    const req = https.get(
      {
        hostname: parsed.hostname,
        // `URL.port` is empty for the scheme default; passing undefined then
        // lets https fall back to 443. Omitting this entirely would send every
        // non-default-port URL to 443 instead.
        port: parsed.port === "" ? undefined : parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
        timeout: opts.timeoutMs ?? 30_000,
      },
      (res) => {
        const status = res.statusCode ?? 0;

        // Follow redirects manually so the token can be dropped on the hop.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          if (redirectsLeft <= 0) {
            reject(new HttpError("Too many redirects", status, url));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          request(next, opts, redirectsLeft - 1, sink).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(
            new HttpError(`HTTP ${status} for ${url}`, status, url)
          );
          return;
        }

        if (sink) {
          res.pipe(sink);
          sink.on("finish", () =>
            resolve({ statusCode: status, headers: res.headers, body: Buffer.alloc(0) })
          );
          sink.on("error", reject);
          res.on("error", reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            statusCode: status,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
        res.on("error", reject);
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out: ${url}`));
    });
    req.on("error", reject);
  });
}

/** Applies `opts.deadlineMs` to a request, if set. */
function withDeadline<T>(p: Promise<T>, opts: HttpOptions, url: string): Promise<T> {
  if (!opts.deadlineMs) return p;
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Request exceeded ${Math.round(opts.deadlineMs! / 1000)}s deadline: ${url}`)),
      opts.deadlineMs
    );
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** GETs `url` and parses the body as JSON. */
export async function httpGetJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await withDeadline(request(url, opts, MAX_REDIRECTS), opts, url);
  return JSON.parse(res.body.toString("utf8")) as T;
}

/** GETs `url` and returns the raw body. */
export async function httpGetBuffer(url: string, opts: HttpOptions = {}): Promise<Buffer> {
  const res = await withDeadline(request(url, opts, MAX_REDIRECTS), opts, url);
  return res.body;
}

/**
 * Downloads `url` to `destPath`.
 *
 * Writes to a `.part` sibling and renames on success, so an interrupted
 * download (power cut mid-window is the realistic case on a station) can never
 * leave a truncated image in the cache that a later run would happily flash.
 */
export async function httpDownloadToFile(
  url: string,
  destPath: string,
  opts: HttpOptions = {}
): Promise<number> {
  const tmpPath = `${destPath}.part`;
  await fs.promises.rm(tmpPath, { force: true });
  const sink = fs.createWriteStream(tmpPath);
  try {
    await withDeadline(
      request(url, { ...opts, accept: opts.accept ?? "application/octet-stream" }, MAX_REDIRECTS, sink),
      opts,
      url
    );
  } catch (e) {
    sink.destroy();
    await fs.promises.rm(tmpPath, { force: true });
    throw e;
  }
  const size = (await fs.promises.stat(tmpPath)).size;
  await fs.promises.rename(tmpPath, destPath);
  return size;
}
