#!/usr/bin/env node
/**
 * Fails when a workflow that runs on a self-hosted runner can be triggered by
 * an event a fork controls.
 *
 * This repository is public and builds on self-hosted runners. A workflow
 * that runs `on: pull_request` (or pull_request_target, issue_comment,
 * workflow_run, …) on one of those runners executes code chosen by whoever
 * opened the pull request, on a machine inside our network.
 *
 * What this check is, and is not:
 *  - It catches a maintainer adding such a trigger by mistake, in review,
 *    before merge.
 *  - It is NOT the security boundary against forks: a fork's pull request
 *    can bring its own workflow files. That boundary is repository and
 *    runner-group settings — see CONTRIBUTING.md ("Self-hosted runners").
 *
 * Deliberately dependency-free: it reads the YAML as text, looking at the
 * top-level `on:` block and for `self-hosted` anywhere in the file.
 */

const fs = require("node:fs");
const path = require("node:path");

const FORK_TRIGGERS = [
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "workflow_run",
  "discussion",
  "discussion_comment",
  "fork",
];

/** Extracts the event names from a workflow's top-level `on:` key. */
function triggers(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^(on|"on"|'on'):/.test(l));
  if (start === -1) return [];
  const first = lines[start].replace(/^(on|"on"|'on'):/, "").trim();
  const found = new Set();
  // Inline forms: `on: push` / `on: [push, pull_request]`.
  for (const m of first.matchAll(/[A-Za-z_]+/g)) found.add(m[0]);
  // Block form: keys or list items at the FIRST indentation level under
  // `on:`, until the next top-level key. Deeper lines (`branches:`, …) are
  // settings of a trigger, not triggers.
  let depth = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (/^\S/.test(l)) break;
    const indent = l.match(/^(\s*)/)[1].length;
    if (depth === null) depth = indent;
    if (indent !== depth) continue;
    const key = l.trim().match(/^-?\s*([A-Za-z_]+)/);
    if (key) found.add(key[1]);
  }
  return [...found];
}

function check(dir) {
  const problems = [];
  if (!fs.existsSync(dir)) return problems;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    if (!/self-hosted/.test(text)) continue;
    const risky = triggers(text).filter((t) => FORK_TRIGGERS.includes(t));
    if (risky.length) {
      problems.push(`${name}: runs on a self-hosted runner and is triggered by ${risky.join(", ")}`);
    }
  }
  return problems;
}

module.exports = { triggers, check, FORK_TRIGGERS };

if (require.main === module) {
  const dir = process.argv[2] ?? path.join(__dirname, "..", ".github", "workflows");
  const problems = check(dir);
  if (problems.length) {
    console.error("Refusing: fork-controllable triggers on self-hosted runners.\n");
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error("\nSee CONTRIBUTING.md, \"Self-hosted runners\". Use a GitHub-hosted runner for");
    console.error("anything a pull request can trigger.");
    process.exit(1);
  }
  console.log("workflows: no fork-controllable triggers on self-hosted runners");
}
