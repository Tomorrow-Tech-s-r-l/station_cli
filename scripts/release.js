#!/usr/bin/env node

/**
 * Interactive release script for station_cli.
 *
 * Usage:  npm run release
 *
 * Steps:
 *   0. Git status check
 *   1. Read current versions (package.json + metadata.json)
 *   2. Pick the release channel (main → vX.Y.Z, development → dev-vX.Y.Z)
 *   3. Set the CLI version (keep / patch / minor / major / custom)
 *   4. Verify the resulting tag is still free locally + on origin
 *   5. Set min_kiosk_app_version (the minimum kiosk that can auto-update to this CLI)
 *   6. Best-effort cross-repo compatibility check against the kiosk app
 *   7. Breaking-change reminder (kiosk minCliVersion)
 *   8. Commit message
 *   9. Pre-release checklist
 *  10. Summary + final confirm
 *  11. git add → commit → push branch  (CI builds the executables and CREATES the tag)
 *
 * IMPORTANT — how releases actually trigger:
 *   The GitHub Actions workflow (.github/workflows/build.yml) runs on every push
 *   to `main` or `development`. It builds the executables and then CREATES the
 *   release tag itself (vX.Y.Z / dev-vX.Y.Z) and regenerates metadata.json from
 *   package.json. This script therefore does NOT create or push a git tag — it
 *   only commits the version bump and pushes the branch.
 *
 *   The single source of truth is package.json:
 *     · version            → the CLI version → the release tag
 *     · minKioskAppVersion → written into the published metadata.json by CI
 *   package-lock.json and the local metadata.json are kept in sync for clarity.
 *
 * Requires Node >= 18. No extra npm dependencies — Node built-ins only.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

// ─── Config ─────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, "..");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const PACKAGE_LOCK = path.join(ROOT, "package-lock.json");
const METADATA = path.join(ROOT, "metadata.json");

// Local checkout of the kiosk app, used for the best-effort compatibility check.
// Override with KIOSK_REPO_PATH=/path/to/amperry_kiosk_local if it lives elsewhere.
const KIOSK_REPO_PATH =
  process.env.KIOSK_REPO_PATH ||
  path.join(ROOT, "..", "..", "app", "amperry_kiosk_local");
const KIOSK_PUBSPEC = path.join(KIOSK_REPO_PATH, "pubspec.yaml");
const KIOSK_CONSTANTS = path.join(KIOSK_REPO_PATH, "lib", "constants.dart");

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const c = {
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

const header = (t) => {
  const line = "─".repeat(60);
  console.log(`\n${c.cyan(line)}\n${c.bold(c.cyan(`  ${t}`))}\n${c.cyan(line)}`);
};
const ok   = (m) => console.log(`  ${c.green("✔")}  ${m}`);
const warn = (m) => console.log(`  ${c.yellow("⚠")}  ${m}`);
const fail = (m) => console.log(`  ${c.red("✖")}  ${m}`);
const info = (m) => console.log(`  ${c.dim("·")}  ${m}`);

// ─── Sync prompt helpers (bash read, no readline quirks) ──────────────────────

function _readLine() {
  const r = spawnSync("bash", ["-c", "read -r line; printf '%s' \"$line\""], {
    stdio: ["inherit", "pipe", "inherit"],
    cwd: ROOT,
  });
  return ((r.stdout || "").toString()).trim();
}

function prompt(question) {
  process.stdout.write(`\n  ${c.bold(question)} `);
  return _readLine();
}

function confirm(question, defaultYes = false) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  process.stdout.write(`\n  ${c.bold(question)} ${c.dim(hint)} `);
  const a = _readLine().toLowerCase();
  if (a === "") return defaultYes;
  return a === "y" || a === "yes";
}

function choose(question, options) {
  console.log(`\n  ${c.bold(question)}`);
  options.forEach((o, i) => console.log(`    ${c.cyan(String(i + 1))}) ${o}`));
  while (true) {
    process.stdout.write(`\n  Enter number [1-${options.length}]: `);
    const n = parseInt(_readLine(), 10);
    if (n >= 1 && n <= options.length) return options[n - 1];
    fail(`Please enter a number between 1 and ${options.length}.`);
  }
}

// ─── Shell helpers ────────────────────────────────────────────────────────────

/** Run a command, throwing on failure. Returns trimmed stdout. */
function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
}

/**
 * Run a command for its exit code only, swallowing stdout/stderr.
 * Returns true on success (exit 0), false otherwise — never throws.
 */
function runQuiet(cmd) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

// ─── Version helpers ──────────────────────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const isValidSemver = (v) => SEMVER_RE.test((v || "").trim());

/** Parse "X.Y.Z" / "vX.Y.Z" / "X.Y.Z+build" → [X, Y, Z] ints. null on failure. */
function parseSemver(raw) {
  const cleaned = (raw || "").trim().replace(/^v/, "").split("+")[0];
  const parts = cleaned.split(".");
  if (parts.length < 2) return null;
  const x = parseInt(parts[0], 10);
  const y = parseInt(parts[1], 10);
  const z = parts.length > 2 ? parseInt(parts[2].split("-")[0], 10) : 0;
  if ([x, y, z].some(Number.isNaN)) return null;
  return [x, y, z];
}

/** Returns true if a >= b (element-wise). */
function gte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/** Negative if a < b, 0 if equal, positive if a > b. */
function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const fmtVer = (arr) => arr.join(".");

function bumpPatch(v) { const [x, y, z] = parseSemver(v); return `${x}.${y}.${z + 1}`; }
function bumpMinor(v) { const [x, y]    = parseSemver(v); return `${x}.${y + 1}.0`; }
function bumpMajor(v) { const [x]       = parseSemver(v); return `${x + 1}.0.0`; }

// ─── File readers / writers ───────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Write JSON with npm's 2-space + trailing-newline convention (diff-friendly). */
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Set package.json version (and minKioskAppVersion) — the source of truth. */
function writePackageVersion(version) {
  const pkg = readJson(PACKAGE_JSON);
  pkg.version = version;
  writeJson(PACKAGE_JSON, pkg);
}

function writePackageMinKiosk(minKiosk) {
  const pkg = readJson(PACKAGE_JSON);
  pkg.minKioskAppVersion = minKiosk;
  writeJson(PACKAGE_JSON, pkg);
}

/** Keep package-lock.json's two version fields aligned with package.json. */
function syncPackageLock(version) {
  if (!fs.existsSync(PACKAGE_LOCK)) return false;
  const lock = readJson(PACKAGE_LOCK);
  let changed = false;
  if (lock.version !== version) { lock.version = version; changed = true; }
  if (lock.packages && lock.packages[""] && lock.packages[""].version !== version) {
    lock.packages[""].version = version;
    changed = true;
  }
  if (changed) writeJson(PACKAGE_LOCK, lock);
  return changed;
}

/** Mirror metadata.json locally (CI regenerates this from package.json at publish). */
function writeMetadata(cliVersion, minKiosk) {
  writeJson(METADATA, {
    cli_version: cliVersion,
    min_kiosk_app_version: minKiosk,
  });
}

/** Read the kiosk's pubspec version → "X.Y.Z" (strips +build). null if absent. */
function readKioskVersion() {
  if (!fs.existsSync(KIOSK_PUBSPEC)) return null;
  const m = fs.readFileSync(KIOSK_PUBSPEC, "utf8").match(/^version:\s*([^\s#]+)/m);
  return m ? m[1].split("+")[0].trim() : null;
}

/** Read the kiosk's minCliVersion constant → "X.Y.Z". null if absent. */
function readKioskMinCli() {
  if (!fs.existsSync(KIOSK_CONSTANTS)) return null;
  const m = fs
    .readFileSync(KIOSK_CONSTANTS, "utf8")
    .match(/const\s+String\s+minCliVersion\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1].trim() : null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `\n${c.bold(c.cyan("╔══════════════════════════════════════════════════════════════╗"))}`
  );
  console.log(
    `${c.bold(c.cyan("║         station_cli  —  Interactive Release Tool             ║"))}`
  );
  console.log(
    `${c.bold(c.cyan("╚══════════════════════════════════════════════════════════════╝"))}\n`
  );

  // ── 0. Git status ────────────────────────────────────────────────────────────
  header("0 · Git status");

  let currentBranch;
  try {
    currentBranch = run("git rev-parse --abbrev-ref HEAD");
    info(`Current branch: ${c.bold(currentBranch)}`);
  } catch {
    fail("Cannot determine git branch. Are you inside a git repo?");
    process.exit(1);
  }

  try {
    const dirty = run("git status --porcelain");
    if (dirty) {
      warn("Working tree has uncommitted changes:");
      dirty.split("\n").forEach((l) => info(c.dim(l)));
      info("Only package.json, package-lock.json and metadata.json will be committed.");
      if (!confirm("Proceed anyway?")) { fail("Aborted."); process.exit(1); }
    } else {
      ok("Working tree is clean.");
    }
  } catch {
    warn("Could not check git status — continuing.");
  }

  // ── 1. Current versions ──────────────────────────────────────────────────────
  header("1 · Current versions");

  const pkg = readJson(PACKAGE_JSON);
  const currentVersion = pkg.version;
  let currentMinKiosk = pkg.minKioskAppVersion || "1.0.0";
  ok(`CLI version (package.json):        ${c.bold(currentVersion)}`);
  ok(`min_kiosk_app_version (package.json): ${c.bold(currentMinKiosk)}`);

  if (!isValidSemver(currentVersion)) {
    fail(`package.json version '${currentVersion}' is not valid semver (X.Y.Z).`);
    process.exit(1);
  }

  try {
    const meta = readJson(METADATA);
    if (meta.min_kiosk_app_version !== currentMinKiosk) {
      warn(
        `metadata.json min_kiosk_app_version (${c.bold(meta.min_kiosk_app_version)}) ` +
        `differs from package.json (${c.bold(currentMinKiosk)}) — package.json wins; CI regenerates metadata.json.`
      );
    }
  } catch {
    info("metadata.json not found — it will be created.");
  }

  // ── 2. Release channel ───────────────────────────────────────────────────────
  header("2 · Release channel");

  info("CI builds on push to 'main' or 'development' and creates the tag itself.");

  const CH_MAIN = "main         (production → v<version>)";
  const CH_DEV  = "development  (prerelease → dev-v<version>)";
  const CH_OTHER = "Other branch (no release will be built)";
  const channelChoice = choose("Which branch are you releasing to?", [
    CH_MAIN, CH_DEV, CH_OTHER,
  ]);

  let targetBranch, tagPrefix, buildsRelease;
  if (channelChoice === CH_MAIN) {
    targetBranch = "main";  tagPrefix = "v";      buildsRelease = true;
  } else if (channelChoice === CH_DEV) {
    targetBranch = "development";  tagPrefix = "dev-v";  buildsRelease = true;
  } else {
    buildsRelease = false;
    tagPrefix = "v";
    while (true) {
      targetBranch = prompt("Enter the branch name:");
      if (targetBranch) break;
      fail("Branch name cannot be empty.");
    }
    warn("CI only builds 'main' and 'development'. This push will NOT produce a release.");
  }
  ok(`Target branch: ${c.bold(targetBranch)}`);

  if (currentBranch !== targetBranch) {
    warn(`You are on '${currentBranch}', but the target is '${targetBranch}'.`);
    if (!confirm(`Switch to '${targetBranch}' now?`)) {
      fail("Aborted. Switch branches manually and re-run.");
      process.exit(1);
    }
    try {
      run(`git checkout ${targetBranch}`);
      ok(`Switched to '${targetBranch}'.`);
    } catch (e) {
      fail(`git checkout failed: ${e.message}`);
      process.exit(1);
    }
  }

  // ── 3. CLI version ───────────────────────────────────────────────────────────
  header("3 · CLI version");

  info(`Current version: ${c.bold(currentVersion)}`);
  const KEEP   = `Keep current   (${currentVersion})`;
  const PATCH  = `Patch bump     (${bumpPatch(currentVersion)})   — bug fixes`;
  const MINOR  = `Minor bump     (${bumpMinor(currentVersion)})   — backward-compatible features`;
  const MAJOR  = `Major bump     (${bumpMajor(currentVersion)})   — breaking changes`;
  const CUSTOM = "Custom…";
  const bumpChoice = choose("How should the version change?", [
    KEEP, PATCH, MINOR, MAJOR, CUSTOM,
  ]);

  let newVersion;
  if (bumpChoice === KEEP)        newVersion = currentVersion;
  else if (bumpChoice === PATCH)  newVersion = bumpPatch(currentVersion);
  else if (bumpChoice === MINOR)  newVersion = bumpMinor(currentVersion);
  else if (bumpChoice === MAJOR)  newVersion = bumpMajor(currentVersion);
  else {
    while (true) {
      newVersion = prompt(`New version [${currentVersion}]:`);
      newVersion = newVersion || currentVersion;
      if (isValidSemver(newVersion)) break;
      fail(`'${newVersion}' is not valid semver (X.Y.Z, no leading v).`);
    }
  }

  if (newVersion !== currentVersion &&
      cmpSemver(parseSemver(newVersion), parseSemver(currentVersion)) < 0) {
    warn(`New version ${c.bold(newVersion)} is LOWER than current ${c.bold(currentVersion)}.`);
    if (!confirm("Release a lower version anyway?")) { fail("Aborted."); process.exit(1); }
  }

  if (newVersion !== currentVersion) {
    writePackageVersion(newVersion);
    const lockSynced = syncPackageLock(newVersion);
    writeMetadata(newVersion, currentMinKiosk);
    ok(`package.json version → ${c.bold(newVersion)}`);
    if (lockSynced) ok("package-lock.json version synced.");
  } else {
    // Repair drift even when the version is unchanged.
    const lockSynced = syncPackageLock(newVersion);
    writeMetadata(newVersion, currentMinKiosk);
    ok(`Keeping version: ${c.bold(newVersion)}`);
    if (lockSynced) ok("package-lock.json version re-synced (was out of date).");
  }

  const cliVersion = parseSemver(newVersion);
  const expectedTag = `${tagPrefix}${newVersion}`;

  // ── 4. Tag availability ──────────────────────────────────────────────────────
  header("4 · Tag availability");

  if (!buildsRelease) {
    info("No release is built for this branch — skipping the tag check.");
  } else {
    info(`CI will create tag: ${c.bold(expectedTag)}`);
    const localExists  = runQuiet(`git rev-parse ${expectedTag}`);
    const remoteExists = runQuiet(`git ls-remote --exit-code --tags origin ${expectedTag}`);
    if (localExists || remoteExists) {
      const where =
        [localExists ? "locally" : null, remoteExists ? "on origin" : null]
          .filter(Boolean).join(" and ");
      fail(`Tag ${c.bold(expectedTag)} already exists ${where}.`);
      fail("Re-pushing would re-publish over an existing release. Bump the version instead.");
      if (!confirm("Proceed anyway? (overwrites the existing release)")) {
        fail("Aborted.");
        process.exit(1);
      }
      warn(`Proceeding — the existing ${expectedTag} release will be overwritten by CI.`);
    } else {
      ok(`Tag ${c.bold(expectedTag)} is available.`);
    }
  }

  // ── 5. min_kiosk_app_version ─────────────────────────────────────────────────
  header("5 · Kiosk app compatibility  (min_kiosk_app_version)");

  info(`Current min_kiosk_app_version: ${c.bold(currentMinKiosk)}`);
  info("Lowest kiosk app version allowed to auto-update to this CLI.");
  info("CI writes this into the published metadata.json from package.json.");

  let minKiosk = currentMinKiosk;
  if (!confirm(`Is ${c.bold(currentMinKiosk)} still correct?`, true)) {
    while (true) {
      const inp = prompt("Enter new min_kiosk_app_version (X.Y.Z, no leading v):");
      if (isValidSemver(inp)) { minKiosk = inp.trim(); break; }
      fail(`'${inp}' is not valid semver.`);
    }
    writePackageMinKiosk(minKiosk);
    writeMetadata(newVersion, minKiosk);
    ok(`min_kiosk_app_version → ${c.bold(minKiosk)}`);
  } else {
    writePackageMinKiosk(minKiosk); // ensure package.json holds the value
    writeMetadata(newVersion, minKiosk);
    ok(`min_kiosk_app_version confirmed: ${c.bold(minKiosk)}`);
  }
  currentMinKiosk = minKiosk;

  // ── 6. Cross-repo compatibility (best-effort, local kiosk checkout) ──────────
  header("6 · Cross-repo compatibility check  (kiosk app)");

  const kioskVerStr = readKioskVersion();
  const kioskMinCliStr = readKioskMinCli();

  if (!kioskVerStr && !kioskMinCliStr) {
    info(`No kiosk checkout found at ${c.dim(KIOSK_REPO_PATH)}.`);
    info("Set KIOSK_REPO_PATH to enable this check — skipping for now.");
  } else {
    if (kioskVerStr) info(`Kiosk app version (pubspec):  ${c.bold(kioskVerStr)}`);
    if (kioskMinCliStr) info(`Kiosk requires CLI >=:        ${c.bold(kioskMinCliStr)}`);

    let blocking = false;

    // (a) Will deployed kiosks accept this CLI? They reject CLI < minCliVersion.
    const kioskMinCli = parseSemver(kioskMinCliStr);
    if (kioskMinCli && cmpSemver(cliVersion, kioskMinCli) < 0) {
      fail(
        `This CLI (${c.bold(newVersion)}) is BELOW the kiosk's minCliVersion ` +
        `(${c.bold(kioskMinCliStr)}) — kiosks would reject it at boot.`
      );
      blocking = true;
    } else if (kioskMinCli) {
      ok(`Kiosks running minCliVersion ${kioskMinCliStr} will accept this CLI.`);
    }

    // (b) Can the currently-released kiosk auto-update to this CLI?
    const kioskVer = parseSemver(kioskVerStr);
    const minKioskParsed = parseSemver(minKiosk);
    if (kioskVer && minKioskParsed && cmpSemver(minKioskParsed, kioskVer) > 0) {
      warn(
        `min_kiosk_app_version (${c.bold(minKiosk)}) is higher than the current ` +
        `kiosk app (${c.bold(kioskVerStr)}) — existing kiosks won't auto-update until they upgrade.`
      );
    } else if (kioskVer && minKioskParsed) {
      ok(`Current kiosk app ${kioskVerStr} can auto-update to this CLI.`);
    }

    if (blocking) {
      console.log();
      if (!confirm("Compatibility check failed. Proceed anyway?")) {
        fail("Aborted. Bump this CLI to satisfy the kiosk, or lower the kiosk's minCliVersion.");
        process.exit(1);
      }
      warn("Proceeding despite a failed compatibility check.");
    }
  }

  // ── 7. Breaking changes → kiosk minCliVersion ───────────────────────────────
  header("7 · Breaking changes  (kiosk minCliVersion)");

  info("If this CLI breaks the CLI↔kiosk contract, the kiosk must raise");
  info("its minCliVersion so older CLIs are rejected at boot.");
  info(`  → ${path.join("amperry_kiosk_local", "lib", "constants.dart")}`);
  info(`  → const String minCliVersion = '…'   (currently ${c.bold(kioskMinCliStr || "unknown")})`);

  if (confirm("Does this release contain breaking changes requiring a kiosk minCliVersion bump?")) {
    warn(`ACTION REQUIRED → set minCliVersion to ${c.bold(newVersion)} in the kiosk repo.`);
    if (!confirm("Have you already updated and pushed minCliVersion in the kiosk repo?")) {
      fail("Update the kiosk repo first, then re-run this script. Aborted.");
      process.exit(1);
    }
    ok("Breaking changes acknowledged — kiosk minCliVersion handled.");
  } else {
    ok("No breaking changes — kiosk minCliVersion unchanged.");
  }

  // ── 8. Commit message ────────────────────────────────────────────────────────
  header("8 · Commit message");

  info("Used as the git commit message and the GitHub release body.");
  const defaultMsg = `chore: release ${newVersion} → ${targetBranch}`;
  let commitMsg = prompt(`Commit message [${defaultMsg}]:`) || defaultMsg;
  ok(`Commit message: ${c.dim(commitMsg)}`);

  // ── 9. Pre-release checklist ─────────────────────────────────────────────────
  header("9 · Pre-release checklist");

  const checks = [
    "Tested locally with real hardware (slots + unlock)?",
    "Build compiles without errors (`npm run build`)?",
    "Tests pass (`npm test`)?",
    "No debug code, temporary hacks, or secrets in the diff?",
  ];
  const failedChecks = [];
  for (const q of checks) {
    if (confirm(q)) ok(q);
    else { fail(q); failedChecks.push(q); }
  }
  if (failedChecks.length > 0) {
    console.log(`\n  ${c.red(c.bold("Failed checks:"))}`);
    failedChecks.forEach(fail);
    if (!confirm(`${failedChecks.length} check(s) failed. Force release anyway? (not recommended)`)) {
      fail("Aborted.");
      process.exit(1);
    }
    warn("Proceeding despite failed checks.");
  } else {
    ok("All pre-release checks passed.");
  }

  // ── 10. Summary + final confirm ──────────────────────────────────────────────
  header("10 · Release summary");

  console.log();
  console.log(`  ${c.bold("CLI version:")}            ${c.green(newVersion)}`);
  console.log(`  ${c.bold("min_kiosk_app_version:")}  ${c.green(minKiosk)}`);
  console.log(`  ${c.bold("Target branch:")}          ${c.green(targetBranch)}`);
  console.log(`  ${c.bold("Release tag (by CI):")}    ${c.green(buildsRelease ? expectedTag : "— none —")}`);
  console.log(`  ${c.bold("Commit message:")}         ${c.dim(commitMsg)}`);
  console.log();

  if (!confirm(`${c.yellow("⚡ Confirm: commit & push to")} ${c.bold(targetBranch)}?`)) {
    warn("Release cancelled. Nothing was pushed.");
    process.exit(0);
  }

  // ── 11. Commit & push branch (CI builds + tags) ──────────────────────────────
  header("11 · Commit & push");

  try {
    run("git add package.json package-lock.json metadata.json");
    ok("Staged: package.json, package-lock.json, metadata.json");
  } catch (e) {
    fail(`git add failed: ${e.message}`);
    process.exit(1);
  }

  const staged = run("git diff --cached --name-only");
  if (!staged) {
    warn("Nothing to commit — pushing existing HEAD.");
  } else {
    try {
      run(`git commit -m ${JSON.stringify(commitMsg)}`);
      ok(`Committed: ${c.dim(commitMsg)}`);
    } catch (e) {
      fail(`git commit failed: ${e.message}`);
      process.exit(1);
    }
  }

  try {
    run(`git push origin ${targetBranch}`);
    ok(`Pushed branch ${c.bold(targetBranch)}.`);
  } catch (e) {
    fail(`git push failed: ${e.message}`);
    info(`The commit is local. Fix and run: git push origin ${targetBranch}`);
    process.exit(1);
  }

  // ── Done ─────────────────────────────────────────────────────────────────────
  console.log(
    `\n${c.green(c.bold("╔══════════════════════════════════════════════════════════════╗"))}`
  );
  if (buildsRelease) {
    console.log(
      `${c.green(c.bold(`║  ✔  Pushed ${newVersion} → ${targetBranch}. CI will tag ${expectedTag}.`.padEnd(63) + "║"))}`
    );
    console.log(
      `${c.green(c.bold("║  GitHub Actions will build the executables and publish.       ║"))}`
    );
  } else {
    console.log(
      `${c.green(c.bold(`║  ✔  Pushed ${newVersion} → ${targetBranch} (no release built).`.padEnd(63) + "║"))}`
    );
  }
  console.log(
    `${c.green(c.bold("╚══════════════════════════════════════════════════════════════╝"))}\n`
  );
}

main().catch((err) => {
  console.error(c.red("\nUnexpected error:"), err);
  process.exit(1);
});
