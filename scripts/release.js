#!/usr/bin/env node

/**
 * Interactive release script for station_cli.
 *
 * Usage:  npm run release
 *
 * Walks the developer through every pre-release step, then commits
 * metadata.json + package.json and pushes to the chosen branch.
 * The GitHub Actions workflow picks up the push and publishes the release.
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, "..");

function readJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, filename), "utf8"));
}

function writeJson(filename, data) {
  fs.writeFileSync(
    path.join(ROOT, filename),
    JSON.stringify(data, null, 2) + "\n",
    "utf8"
  );
}

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
}

function isValidSemver(v) {
  return /^\d+\.\d+\.\d+$/.test((v || "").trim());
}

// ANSI colours
const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function header(title) {
  const line = "─".repeat(58);
  console.log(`\n${c.cyan(line)}`);
  console.log(c.bold(c.cyan(`  ${title}`)));
  console.log(c.cyan(line));
}

const ok   = (m) => console.log(`  ${c.green("✔")}  ${m}`);
const warn = (m) => console.log(`  ${c.yellow("⚠")}  ${m}`);
const fail = (m) => console.log(`  ${c.red("✖")}  ${m}`);
const info = (m) => console.log(`  ${c.dim("·")}  ${m}`);

/** Synchronous stdin prompt — returns trimmed string. */
function prompt(question) {
  process.stdout.write(`\n  ${c.bold(question)} `);
  const r = spawnSync("bash", ["-c", "read -r line; printf '%s' \"$line\""], {
    stdio: ["inherit", "pipe", "inherit"],
    cwd: ROOT,
  });
  return ((r.stdout || "").toString()).trim();
}

/** Yes/no confirm — returns boolean. */
function confirm(question, defaultYes = false) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  process.stdout.write(`\n  ${c.bold(question)} ${c.dim(hint)} `);
  const r = spawnSync("bash", ["-c", "read -r line; printf '%s' \"$line\""], {
    stdio: ["inherit", "pipe", "inherit"],
    cwd: ROOT,
  });
  const a = ((r.stdout || "").toString()).trim().toLowerCase();
  if (a === "") return defaultYes;
  return a === "y" || a === "yes";
}

/** Numbered-list choice — returns chosen option string. */
function choose(question, options) {
  console.log(`\n  ${c.bold(question)}`);
  options.forEach((opt, i) =>
    console.log(`    ${c.cyan(String(i + 1))}) ${opt}`)
  );
  while (true) {
    process.stdout.write(`\n  Enter number [1-${options.length}]: `);
    const r = spawnSync("bash", ["-c", "read -r line; printf '%s' \"$line\""], {
      stdio: ["inherit", "pipe", "inherit"],
      cwd: ROOT,
    });
    const n = parseInt(((r.stdout || "").toString()).trim(), 10);
    if (n >= 1 && n <= options.length) return options[n - 1];
    fail(`Please enter a number between 1 and ${options.length}.`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `\n${c.bold(c.cyan("╔══════════════════════════════════════════════════════════╗"))}`
  );
  console.log(
    `${c.bold(c.cyan("║      station_cli  —  Interactive Release Tool            ║"))}`
  );
  console.log(
    `${c.bold(c.cyan("╚══════════════════════════════════════════════════════════╝"))}\n`
  );

  // ── 0. Git status ────────────────────────────────────────────────────────────
  header("0 · Git status");

  let currentBranch;
  try {
    currentBranch = run("git rev-parse --abbrev-ref HEAD");
    info(`Current branch: ${c.bold(currentBranch)}`);
  } catch {
    fail("Cannot determine current git branch. Are you inside a git repo?");
    process.exit(1);
  }

  try {
    const dirty = run("git status --porcelain");
    if (dirty) {
      warn("Working tree has uncommitted changes:");
      dirty.split("\n").forEach((l) => info(c.dim(l)));
      if (!confirm("Proceed anyway? (only metadata.json / package.json will be committed)")) {
        fail("Aborted.");
        process.exit(1);
      }
    } else {
      ok("Working tree is clean.");
    }
  } catch {
    warn("Could not check git status — continuing.");
  }

  // ── 1. Read current versions ─────────────────────────────────────────────────
  header("1 · Current versions");

  const pkg = readJson("package.json");
  const cliVersion = pkg.version;
  ok(`station_cli version in package.json: ${c.bold(cliVersion)}`);

  let meta = { cli_version: cliVersion, min_kiosk_app_version: "1.0.0" };
  try {
    meta = readJson("metadata.json");
    ok(
      `metadata.json: cli_version=${c.bold(meta.cli_version)},  min_kiosk_app_version=${c.bold(meta.min_kiosk_app_version)}`
    );
  } catch {
    warn("metadata.json not found — will create it.");
  }

  // ── 2. Release channel ───────────────────────────────────────────────────────
  header("2 · Release channel");

  const branch = choose("Which branch are you releasing to?", [
    "main  (production)",
    "development  (dev / prerelease)",
  ]);
  const targetBranch = branch.startsWith("main") ? "main" : "development";
  const tagPrefix = targetBranch === "development" ? "dev-v" : "v";
  const expectedTag = `${tagPrefix}${cliVersion}`;

  ok(`Target branch: ${c.bold(targetBranch)}`);
  ok(`Release tag will be: ${c.bold(expectedTag)}`);

  if (currentBranch !== targetBranch) {
    warn(`You are on '${currentBranch}' but releasing to '${targetBranch}'.`);
    if (!confirm(`Switch to '${targetBranch}' now?`)) {
      fail("Aborted. Switch branch manually and re-run.");
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

  // ── 3. Version number ────────────────────────────────────────────────────────
  header("3 · Version number");

  info(`Current version in package.json: ${c.bold(cliVersion)}`);
  const versionOk = confirm(
    `Is ${c.bold(cliVersion)} the correct version for this release?`,
    true
  );
  if (!versionOk) {
    let newVersion;
    while (true) {
      newVersion = prompt("Enter the correct version (X.Y.Z, no leading v):");
      if (isValidSemver(newVersion)) break;
      fail(`'${newVersion}' is not valid semver. Try again.`);
    }
    pkg.version = newVersion.trim();
    writeJson("package.json", pkg);
    meta.cli_version = pkg.version;
    ok(`package.json version updated to ${c.bold(pkg.version)}.`);
  } else {
    ok(`Version confirmed: ${c.bold(cliVersion)}`);
  }

  // ── 4. min_kiosk_app_version ─────────────────────────────────────────────────
  header("4 · Kiosk app compatibility  (metadata.json)");

  info(`Current min_kiosk_app_version: ${c.bold(meta.min_kiosk_app_version)}`);
  info("This is the minimum kiosk version that can auto-update to this CLI.");
  info("The kiosk reads metadata.json from the GitHub release assets.");

  const minKioskOk = confirm(
    `Is ${c.bold(meta.min_kiosk_app_version)} still the correct minimum kiosk version?`,
    true
  );
  if (!minKioskOk) {
    let newMin;
    while (true) {
      newMin = prompt("Enter new min_kiosk_app_version (X.Y.Z, no leading v):");
      if (isValidSemver(newMin)) break;
      fail(`'${newMin}' is not valid semver. Try again.`);
    }
    meta.min_kiosk_app_version = newMin.trim();
    ok(`min_kiosk_app_version updated to ${c.bold(meta.min_kiosk_app_version)}.`);
  } else {
    ok(`min_kiosk_app_version confirmed: ${c.bold(meta.min_kiosk_app_version)}`);
  }

  // Keep cli_version in sync and write
  meta.cli_version = pkg.version;
  writeJson("metadata.json", meta);
  ok(`metadata.json saved: ${JSON.stringify(meta)}`);

  // ── 5. Breaking changes → kiosk constants.dart ───────────────────────────────
  header("5 · Breaking changes  (kiosk minCliVersion)");

  info("If this CLI version breaks backward compatibility, the kiosk needs");
  info("its minCliVersion constant updated so old CLIs are rejected at boot.");
  info(`  → amperry-kiosk-local/lib/constants.dart`);
  info(`  → const String minCliVersion = '…'`);

  const hasBreaking = confirm(
    "Does this release contain breaking changes that require raising minCliVersion in the kiosk?"
  );
  if (hasBreaking) {
    warn("ACTION REQUIRED → update minCliVersion in amperry-kiosk-local/lib/constants.dart");
    warn(`  Suggested value: ${c.bold(pkg.version)}`);
    const kioskUpdated = confirm(
      "Have you already updated minCliVersion in the kiosk repo and pushed it?"
    );
    if (!kioskUpdated) {
      fail("Please update the kiosk repo first, then re-run this script. Aborted.");
      process.exit(1);
    }
    ok("Breaking changes acknowledged — kiosk constants.dart updated.");
  } else {
    ok("No breaking changes — kiosk minCliVersion unchanged.");
  }

  // ── 6. Commit message ────────────────────────────────────────────────────────
  header("6 · Commit message");

  info("Used as the git commit message and the GitHub release body.");
  let commitMsg = "";
  while (!commitMsg) {
    commitMsg = prompt("Enter a short commit / changelog message:");
    if (!commitMsg) fail("Commit message cannot be empty.");
  }

  // ── 7. Pre-release checklist ─────────────────────────────────────────────────
  header("7 · Pre-release checklist");

  const checks = [
    "Tested locally with real hardware (slots + unlock)?",
    "Build compiles without errors (`npm run build`)?",
    "No debug code, temporary hacks, or secrets in the diff?",
  ];

  const failedChecks = [];
  for (const q of checks) {
    if (confirm(q)) {
      ok(q);
    } else {
      fail(q);
      failedChecks.push(q);
    }
  }

  if (failedChecks.length > 0) {
    console.log(`\n  ${c.red(c.bold("Release blocked — failed checks:"))}`);
    failedChecks.forEach(fail);
    if (!confirm(`${failedChecks.length} check(s) failed. Force release anyway? (not recommended)`)) {
      fail("Aborted.");
      process.exit(1);
    }
    warn("Proceeding despite failed checks.");
  } else {
    ok("All pre-release checks passed.");
  }

  // ── 8. Summary + final confirmation ─────────────────────────────────────────
  header("8 · Release summary");

  console.log();
  console.log(`  ${c.bold("CLI version:")}             ${c.green(pkg.version)}`);
  console.log(`  ${c.bold("Release tag:")}             ${c.green(expectedTag)}`);
  console.log(`  ${c.bold("Target branch:")}           ${c.green(targetBranch)}`);
  console.log(`  ${c.bold("min_kiosk_app_version:")}   ${c.green(meta.min_kiosk_app_version)}`);
  console.log(`  ${c.bold("Commit message:")}          ${c.dim(commitMsg)}`);
  console.log();

  if (!confirm(`${c.yellow("⚡ Confirm: commit and push to")} ${c.bold(targetBranch)}?`)) {
    warn("Release cancelled. No changes were pushed.");
    process.exit(0);
  }

  // ── 9. Commit and push ───────────────────────────────────────────────────────
  header("9 · Committing and pushing");

  try {
    run("git add metadata.json package.json");
    ok("Staged: metadata.json, package.json");
  } catch (e) {
    fail(`git add failed: ${e.message}`);
    process.exit(1);
  }

  const staged = run("git diff --cached --name-only");
  if (!staged) {
    warn("Nothing changed — pushing existing HEAD.");
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
    ok(`Pushed to ${c.bold(targetBranch)}.`);
  } catch (e) {
    fail(`git push failed: ${e.message}`);
    info(`Your commit is local. Fix the issue then: git push origin ${targetBranch}`);
    process.exit(1);
  }

  // ── Done ─────────────────────────────────────────────────────────────────────
  console.log(
    `\n${c.green(c.bold("╔══════════════════════════════════════════════════════════╗"))}`
  );
  console.log(
    `${c.green(c.bold(`║  ✔  Release ${pkg.version} pushed to '${targetBranch}'.`.padEnd(59) + "║"))}`
  );
  console.log(
    `${c.green(c.bold("║  GitHub Actions will build & publish the release tag.    ║"))}`
  );
  console.log(
    `${c.green(c.bold("╚══════════════════════════════════════════════════════════╝"))}\n`
  );
}

main().catch((err) => {
  console.error(c.red("\nUnexpected error:"), err);
  process.exit(1);
});
