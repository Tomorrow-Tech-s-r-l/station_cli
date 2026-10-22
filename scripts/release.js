#!/usr/bin/env node

/**
 * Interactive release script for station_cli.
 *
 * Usage:  npm run release
 *
 * Steps:
 *   0. Git status check
 *   1. Read the current version (package.json)
 *   2. Pick the release channel (main → vX.Y.Z, development → dev-vX.Y.Z)
 *   3. Set the CLI version (keep / patch / minor / major / custom)
 *   4. Verify the resulting tag is still free locally + on origin
 *   5. Commit message
 *   6. Pre-release checklist
 *   7. Summary + final confirm
 *   8. git add → commit → push branch  (CI builds the executables and CREATES the tag)
 *
 * IMPORTANT — how releases actually trigger:
 *   The GitHub Actions workflow (.github/workflows/build.yml) runs on every push
 *   to `main` or `development`. It builds the executables and then CREATES the
 *   release tag itself (vX.Y.Z / dev-vX.Y.Z). This script therefore does NOT
 *   create or push a git tag — it only commits the version bump and pushes
 *   the branch.
 *
 * Compatibility is not decided here. Which kiosks and firmware this CLI works
 * with is computed by CI from contract runs against the real releases
 * (firmware_contract.yml here, kiosk_cli_contract.yml in the kiosk repo) and
 * published by release-compatibility-cli as compatibility.json; the release job writes
 * this release's metadata.json from it. Nothing to declare, nothing to scrape.
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

/** Negative if a < b, 0 if equal, positive if a > b. */
function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

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

/** Set package.json version — the source of truth for the release tag. */
function writePackageVersion(version) {
  const pkg = readJson(PACKAGE_JSON);
  pkg.version = version;
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
      info("Only package.json and package-lock.json will be committed.");
      if (!confirm("Proceed anyway?")) { fail("Aborted."); process.exit(1); }
    } else {
      ok("Working tree is clean.");
    }
  } catch {
    warn("Could not check git status — continuing.");
  }

  // ── 1. Current version ───────────────────────────────────────────────────────
  header("1 · Current version");

  const pkg = readJson(PACKAGE_JSON);
  const currentVersion = pkg.version;
  ok(`CLI version (package.json): ${c.bold(currentVersion)}`);

  if (!isValidSemver(currentVersion)) {
    fail(`package.json version '${currentVersion}' is not valid semver (X.Y.Z).`);
    process.exit(1);
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
    ok(`package.json version → ${c.bold(newVersion)}`);
    if (lockSynced) ok("package-lock.json version synced.");
  } else {
    // Repair drift even when the version is unchanged.
    const lockSynced = syncPackageLock(newVersion);
    ok(`Keeping version: ${c.bold(newVersion)}`);
    if (lockSynced) ok("package-lock.json version re-synced (was out of date).");
  }

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
      // build.yml publishes a dev release once per version (force_republish
      // replaces it on purpose); main re-publishes over it.
      const dev = targetBranch === "development";
      fail(dev
        ? "CI builds and tests it but publishes nothing over an existing dev release. Bump the version instead."
        : "Re-pushing would re-publish over an existing release. Bump the version instead.");
      if (!confirm(dev ? "Proceed anyway? (no new dev release)" : "Proceed anyway? (overwrites the existing release)")) {
        fail("Aborted.");
        process.exit(1);
      }
      warn(dev
        ? `Proceeding — ${expectedTag} stays as it is (run build.yml with force_republish to replace it).`
        : `Proceeding — the existing ${expectedTag} release will be overwritten by CI.`);
    } else {
      ok(`Tag ${c.bold(expectedTag)} is available.`);
    }
  }

  // ── 5. Commit message ────────────────────────────────────────────────────────
  header("5 · Commit message");

  info("Used as the git commit message and the GitHub release body.");
  const defaultMsg = `chore: release ${newVersion} → ${targetBranch}`;
  let commitMsg = prompt(`Commit message [${defaultMsg}]:`) || defaultMsg;
  ok(`Commit message: ${c.dim(commitMsg)}`);

  // ── 6. Pre-release checklist ─────────────────────────────────────────────────
  header("6 · Pre-release checklist");

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

  // ── 7. Summary + final confirm ───────────────────────────────────────────────
  header("7 · Release summary");

  console.log();
  console.log(`  ${c.bold("CLI version:")}            ${c.green(newVersion)}`);
  console.log(`  ${c.bold("Compatibility:")}          ${c.dim("computed by CI (compatibility.json)")}`);
  console.log(`  ${c.bold("Target branch:")}          ${c.green(targetBranch)}`);
  console.log(`  ${c.bold("Release tag (by CI):")}    ${c.green(buildsRelease ? expectedTag : "— none —")}`);
  console.log(`  ${c.bold("Commit message:")}         ${c.dim(commitMsg)}`);
  console.log();

  if (!confirm(`${c.yellow("⚡ Confirm: commit & push to")} ${c.bold(targetBranch)}?`)) {
    warn("Release cancelled. Nothing was pushed.");
    process.exit(0);
  }

  // ── 8. Commit & push branch (CI builds + tags) ───────────────────────────────
  header("8 · Commit & push");

  try {
    run("git add package.json package-lock.json");
    ok("Staged: package.json, package-lock.json");
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
