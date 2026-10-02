/**
 * The fw-* commands as a caller sees them: the built binary, spawned.
 *
 * Pins the contract the kiosk app and shell scripts rely on — exactly one JSON
 * document on stdout, hints only on stderr, non-zero exit on failure — and
 * the refusals that exist for safety: credentials on the command line, the
 * wrong station model, and a firmware lock held by another process. None of
 * these need a serial port, because each refusal happens before one is opened.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");

function run(args, { env = {}, input } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-home-"));
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) {
    if (/^(GITHUB_TOKEN|GH_TOKEN|STATION_CLI_|AMPERRY_FWU_|XDG_)/.test(k)) delete clean[k];
  }
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...clean, HOME: home, STATION_CLI_SYSTEM_CONFIG: path.join(home, "none.json"), ...env },
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: tryJson(r.stdout) };
}
function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

test("a credential on the command line is refused, with the safe alternative", () => {
  const r = run(["fw-status", "--github-token", "ghp_on_argv"]);
  assert.equal(r.code, 1);
  assert.ok(r.json, "stdout is still exactly one JSON document");
  assert.equal(r.json.success, false);
  assert.match(r.json.error, /visible to every user/);
  assert.match(r.json.error, /--config-stdin/);
  assert.ok(!r.stdout.includes("ghp_on_argv") && !r.stderr.includes("ghp_on_argv"), "the value is never echoed");
});

test("--github-token is not advertised in --help", () => {
  const r = run(["fw-apply", "--help"]);
  assert.match(r.stdout, /--config-stdin/);
  assert.ok(!/--github-token/.test(r.stdout));
});

test("firmware commands refuse an S0TT station", () => {
  const r = run(["S0TT6", "fw-status"]);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /supported on S1TT stations only \(current model: S0TT6\)/);
});

test("a firmware lock held by a live process is respected, and its holder named", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-lock-"));
  const lock = path.join(dir, "fwu.lock");
  fs.writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, command: "fw-apply", startedAt: new Date().toISOString(), host: "h", bootId: null })
  );
  const r = run(["fw-status"], { env: { STATION_CLI_FWU_LOCK_FILE: lock } });
  assert.equal(r.code, 1);
  assert.match(r.json.error, /already in progress/);
  assert.equal(r.json.lock.pid, process.pid);
  assert.equal(r.json.lock.file, lock);
});

test("an invalid configuration fails before any device is touched, naming each problem", () => {
  const r = run(["fw-plan", "--config-stdin"], {
    input: JSON.stringify({ firmware: { minBatteryPercent: 500, channel: "nightly" } }),
  });
  assert.equal(r.code, 1);
  assert.equal(r.json.error, "invalid configuration");
  assert.equal(r.json.errors.length, 2);
  assert.ok(r.json.errors.every((e) => e.startsWith("stdin: ")));
  assert.match(r.stderr, /station-cli config check/, "stderr points at the diagnosis command");
});

test("an unknown channel alias on the command line is rejected", () => {
  const r = run(["fw-plan", "--channel", "nightly"]);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /Unknown channel "nightly"/);
});

test("--no-hints keeps stderr quiet", () => {
  const r = run(["fw-status", "--github-token", "x", "--no-hints"]);
  assert.equal(r.stderr.trim(), "");
});

test("config schema prints a JSON Schema document", () => {
  const r = run(["config", "schema"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(r.json.properties.firmware.properties.sources);
});

test("config check reports where each setting came from, and flags what is missing", () => {
  const r = run(["config", "check", "--config-stdin"], {
    input: JSON.stringify({ firmware: { channel: "beta" } }),
  });
  assert.equal(r.code, 0);
  assert.equal(r.json.effective.firmware.channel, "beta");
  assert.deepEqual(r.json.layers.find((l) => l.name === "stdin").keys, ["firmware.channel"]);
  assert.equal(r.json.derived.credentialPresent, false);
  assert.match(r.stderr, /no firmware source/);
  assert.match(r.stderr, /no GitHub credential/);
});

test("config check exits non-zero on an invalid document", () => {
  const r = run(["config", "check", "--config-stdin"], { input: "{bad json" });
  assert.equal(r.code, 1);
  assert.equal(r.json.success, false);
});
