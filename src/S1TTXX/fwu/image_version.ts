import * as fs from "node:fs";
import * as path from "node:path";

import { formatVersion, parseVersion, toHeaderWord, Version } from "./version";

/**
 * The version a one-shot flash (`firmware-update`, `pb-firmware-update`)
 * stamps into the app header, when the operator did not pass --app-version.
 *
 * It used to be a constant (0x00040000 for a board, 0 for a pack), stamped
 * whatever the image was — so a flashed device then reported a version that
 * had nothing to do with its firmware, and every later version comparison
 * was wrong. Now it comes from the image itself, in this order:
 *
 *   1. `metadata.json` next to the image, `firmware_version` (what the
 *      firmware's release job publishes beside every image);
 *   2. the version in the release asset name, `<family>-firmware-X.Y.Z.bin`,
 *      which the same job derives from the same package.json;
 *   3. otherwise an error: better no flash than a wrong header.
 */

export interface ImageVersion {
  word: number;
  version: Version;
  source: "flag" | "metadata" | "file-name";
}

export function parseHeaderWordFlag(raw: string): number {
  const text = raw.trim();
  const value = /^0x[0-9a-f]+$/i.test(text) ? parseInt(text, 16) : NaN;
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`--app-version must be a hex word such as 0x00030200, got "${raw}"`);
  }
  return value >>> 0;
}

export function resolveImageVersion(imagePath: string, flag: string | undefined): ImageVersion {
  if (flag !== undefined) {
    const word = parseHeaderWordFlag(flag);
    return { word, version: [(word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff], source: "flag" };
  }
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(path.dirname(path.resolve(imagePath)), "metadata.json"), "utf8")
    ) as Record<string, unknown>;
    const v = typeof meta.firmware_version === "string" ? parseVersion(meta.firmware_version) : null;
    if (v) return { word: toHeaderWord(v), version: v, source: "metadata" };
  } catch {
    // no metadata next to the image: try the asset name
  }
  const m = /-firmware-(\d+\.\d+\.\d+)\.bin$/i.exec(path.basename(imagePath));
  const v = m ? parseVersion(m[1]) : null;
  if (v) return { word: toHeaderWord(v), version: v, source: "file-name" };
  throw new Error(
    `cannot tell which version ${path.basename(imagePath)} is: pass --app-version 0x00XXYYZZ, ` +
      `or keep the release's metadata.json next to the image`
  );
}

export function describeImageVersion(v: ImageVersion): string {
  return `${formatVersion(v.version)} (from ${v.source})`;
}
