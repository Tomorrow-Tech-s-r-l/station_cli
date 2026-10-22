/** The self-hosted-runner guard: it must catch every trigger form, and pass today's workflows. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { triggers, check } = require("../scripts/check-workflows");

function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test("reads every trigger form", () => {
  assert.deepEqual(triggers("on: push\njobs: {}\n"), ["push"]);
  assert.deepEqual(triggers("on: [push, pull_request]\n").sort(), ["pull_request", "push"]);
  assert.deepEqual(triggers("on:\n  push:\n    branches: [main]\n  pull_request_target:\njobs:\n").sort(), ["pull_request_target", "push"]);
  assert.deepEqual(triggers("on:\n  - push\n  - issue_comment\njobs:\n").sort(), ["issue_comment", "push"]);
});

test("does not mistake nested keys for triggers", () => {
  assert.deepEqual(triggers("on:\n  push:\n    branches:\n      - pull_request\njobs:\n"), ["push"]);
});

test("flags a fork trigger on a self-hosted workflow", () => {
  const dir = dirWith({ "bad.yml": "on: [push, pull_request]\njobs:\n  b:\n    runs-on: [self-hosted, Linux]\n" });
  assert.equal(check(dir).length, 1);
});

test("allows a fork trigger on a GitHub-hosted workflow", () => {
  const dir = dirWith({ "ok.yml": "on: pull_request\njobs:\n  b:\n    runs-on: ubuntu-latest\n" });
  assert.deepEqual(check(dir), []);
});

test("this repository's workflows pass", () => {
  assert.deepEqual(check(path.join(__dirname, "..", ".github", "workflows")), []);
});
