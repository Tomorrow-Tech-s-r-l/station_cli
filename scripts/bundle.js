#!/usr/bin/env node
/**
 * Writes `bundle/`, which `pkg` packs into the executable (package.json
 * `pkg.assets`) and src/utils/build_info.ts reads at run time:
 *
 *   bundle/build-info.json     {"tag", "commit"} of the release being built
 *   bundle/compatibility.json  release-compat's published compatibility.json,
 *                              the copy the CLI falls back to when it can
 *                              neither download nor find a cached one
 *
 *   node scripts/bundle.js --tag <release tag> [--commit <sha>]
 *
 * The compatibility file is downloaded, never written by hand: with no
 * COMPAT_TOKEN (forks, local builds) the bundle simply has none, and the CLI
 * then needs the network or its cache to install firmware (it fails closed).
 * A downloaded file that is not `compatibility/v1` is refused.
 *
 * Env: COMPAT_TOKEN, COMPAT_REPO (default Tomorrow-Tech-s-r-l/release-compat),
 * COMPAT_RELEASE (default current), COMPAT_ASSET (default compatibility.json).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "bundle");
const API = process.env.GITHUB_API_URL || "https://api.github.com";

async function get(url, token, accept) {
  const res = await fetch(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "User-Agent": "station-cli-bundle",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function fetchCompatibility(token) {
  const repo = process.env.COMPAT_REPO || "Tomorrow-Tech-s-r-l/release-compat";
  const release = process.env.COMPAT_RELEASE || "current";
  const assetName = process.env.COMPAT_ASSET || "compatibility.json";
  const rel = await (await get(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(release)}`, token, "application/vnd.github+json")).json();
  const asset = (rel.assets || []).find((a) => a.name === assetName);
  if (!asset) throw new Error(`${repo}@${release} has no asset ${assetName}`);
  const text = await (await get(asset.url, token, "application/octet-stream")).text();
  const doc = JSON.parse(text);
  if (doc.format !== "compatibility/v1" || !Number.isInteger(doc.sequence)) {
    throw new Error(`${assetName} is not compatibility/v1`);
  }
  return { text, sequence: doc.sequence, from: `${repo}@${release}` };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const tag = opt("--tag");
  if (!tag) {
    console.error("usage: bundle.js --tag <release tag> [--commit <sha>]");
    process.exit(2);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const info = { tag, commit: opt("--commit") || process.env.GITHUB_SHA || null };
  fs.writeFileSync(path.join(OUT, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
  console.log(`bundle: build-info ${JSON.stringify(info)}`);

  const token = process.env.COMPAT_TOKEN;
  if (!token) {
    console.log("::warning::COMPAT_TOKEN not set — this build carries no bundled compatibility.json");
    return;
  }
  const c = await fetchCompatibility(token);
  fs.writeFileSync(path.join(OUT, "compatibility.json"), c.text);
  console.log(`bundle: compatibility.json sequence ${c.sequence} from ${c.from}`);
}

main().catch((e) => {
  console.error(`bundle.js: ${e.message}`);
  process.exit(1);
});
