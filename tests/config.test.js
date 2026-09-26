/**
 * The layered configuration: precedence, validation, and — above all — that a
 * credential can never be printed by accident or supplied on the command line.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");

const { loadConfig, printableConfig, deepMerge, envLayer } = require("../dist/config/loader");
const {
  defaultConfig,
  validateRaw,
  effectiveLockFile,
  CONFIG_JSON_SCHEMA,
  VALIDATOR_KNOWN_KEYS,
} = require("../dist/config/schema");
const { Secret } = require("../dist/config/secret");

const CANARY = "ghp_CANARY_must_never_be_printed_0123456789";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
}
function writeJson(dir, name, obj, mode = 0o600) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  fs.chmodSync(p, mode);
  return p;
}
/** Isolated load: no real /etc, no real home, no inherited env. */
function load(opts = {}) {
  const dir = tmp();
  return loadConfig({
    systemConfigPath: path.join(dir, "absent-system.json"),
    userConfigPath: path.join(dir, "absent-user.json"),
    env: {},
    ...opts,
  });
}

// --- defaults -------------------------------------------------------------

test("built-in defaults carry no deployment knowledge", () => {
  const d = defaultConfig();
  assert.deepEqual(d.firmware.sources, {}, "no firmware repositories are baked in");
  assert.equal(d.credentials.github.token, null);
  const text = JSON.stringify(d).toLowerCase();
  for (const word of ["amperry", "tomorrow", "github.com"]) {
    assert.ok(!text.includes(word), `defaults must not mention "${word}"`);
  }
});

test("defaults are conservative", () => {
  const f = defaultConfig().firmware;
  assert.equal(f.channel, "stable");
  assert.equal(f.minBatteryPercent, 30);
  assert.equal(f.maxTargets, 6, "a hand-run fw-apply is capped by default (F11)");
  assert.ok(f.maxDurationSeconds > 0, "runs have a time budget by default (F8)");
});

test("the lock sits next to the state file unless set explicitly", () => {
  const f = { ...defaultConfig().firmware, stateFile: "/var/lib/x/fwu-state.json", lockFile: null };
  assert.equal(effectiveLockFile(f), "/var/lib/x/fwu.lock");
  assert.equal(effectiveLockFile({ ...f, lockFile: "/run/fwu.lock" }), "/run/fwu.lock");
});

// --- precedence -----------------------------------------------------------

test("layers apply in order: system < user < env < file < stdin < flags", async () => {
  const dir = tmp();
  const system = writeJson(dir, "system.json", { firmware: { channel: "beta", minBatteryPercent: 10, maxTargets: 1, attemptsPerTarget: 1, maxFailures: 1 } });
  const user = writeJson(dir, "user.json", { firmware: { minBatteryPercent: 20, maxTargets: 2, attemptsPerTarget: 2, maxFailures: 2 } });
  const file = writeJson(dir, "file.json", { firmware: { maxTargets: 4, attemptsPerTarget: 4, maxFailures: 4 } });
  const r = await loadConfig({
    systemConfigPath: system,
    userConfigPath: user,
    env: { STATION_CLI_FWU_CACHE_DIR: "/env/cache" },
    configPath: file,
    configStdin: true,
    readStdin: async () => JSON.stringify({ firmware: { attemptsPerTarget: 5, maxFailures: 5 } }),
    flags: { firmware: { maxFailures: 7 } },
  });
  assert.deepEqual(r.errors, []);
  const f = r.config.firmware;
  assert.equal(f.channel, "beta"); // system only
  assert.equal(f.minBatteryPercent, 20); // user over system
  assert.equal(f.cacheDir, "/env/cache"); // env
  assert.equal(f.maxTargets, 4); // file over user
  assert.equal(f.attemptsPerTarget, 5); // stdin over file
  assert.equal(f.maxFailures, 7); // flags over everything
  assert.deepEqual(
    r.layers.filter((l) => l.applied).map((l) => l.name),
    ["defaults", "system", "user", "env", "file", "stdin", "flags"]
  );
});

test("deep merge combines objects and replaces everything else", () => {
  const merged = deepMerge(
    { firmware: { sources: { interface: { provider: "github", repo: "a/b" } }, channel: "stable" } },
    { firmware: { sources: { powerbank: { provider: "github", repo: "c/d" } } } }
  );
  assert.deepEqual(Object.keys(merged.firmware.sources), ["interface", "powerbank"]);
  assert.equal(merged.firmware.channel, "stable");
});

test("optional layers may be absent; an explicitly requested --config may not", async () => {
  const r = await load();
  assert.deepEqual(r.errors, []);
  const bad = await load({ configPath: "/definitely/not/here.json" });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /--config/);
});

test("STATION_CLI_CONFIG names a file when --config is not given", async () => {
  const dir = tmp();
  const f = writeJson(dir, "c.json", { firmware: { channel: "beta" } });
  const r = await load({ env: { STATION_CLI_CONFIG: f } });
  assert.equal(r.config.firmware.channel, "beta");
});

// --- environment ----------------------------------------------------------

test("env: STATION_CLI_* wins over the legacy and conventional names", () => {
  const e = envLayer({ STATION_CLI_GITHUB_TOKEN: "a", AMPERRY_FWU_GITHUB_TOKEN: "b", GITHUB_TOKEN: "c", GH_TOKEN: "d" });
  assert.equal(e.credentials.github.token, "a");
  assert.equal(envLayer({ AMPERRY_FWU_GITHUB_TOKEN: "b", GITHUB_TOKEN: "c" }).credentials.github.token, "b");
  assert.equal(envLayer({ GITHUB_TOKEN: "c", GH_TOKEN: "d" }).credentials.github.token, "c");
});

test("env: legacy AMPERRY_FWU_* paths are still honoured", () => {
  const e = envLayer({ AMPERRY_FWU_CACHE_DIR: "/c", AMPERRY_FWU_STATE_FILE: "/s.json" });
  assert.equal(e.firmware.cacheDir, "/c");
  assert.equal(e.firmware.stateFile, "/s.json");
});

// --- validation -----------------------------------------------------------

test("an error names the layer it came from", async () => {
  const r = await load({
    configStdin: true,
    readStdin: async () => JSON.stringify({ firmware: { channel: "nightly" } }),
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^stdin: firmware\.channel must be "stable" or "beta"/);
});

test("unknown keys are warnings (typos), not errors", async () => {
  const r = await load({
    configStdin: true,
    readStdin: async () => JSON.stringify({ firmware: { minBaterryPercent: 50 } }),
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /firmware\.minBaterryPercent unknown key/.test(w)));
});

test("malformed JSON on stdin is a clear error", async () => {
  const r = await load({ configStdin: true, readStdin: async () => "{nope" });
  assert.match(r.errors[0], /--config-stdin: not valid JSON/);
});

test("empty stdin is simply not applied", async () => {
  const r = await load({ configStdin: true, readStdin: async () => "  \n" });
  assert.deepEqual(r.errors, []);
  assert.equal(r.layers.find((l) => l.name === "stdin").applied, false);
});

test("an editor's $schema key is accepted and ignored", async () => {
  const r = await load({
    configStdin: true,
    readStdin: async () => JSON.stringify({ $schema: "x", firmware: { channel: "beta" } }),
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("validation catches bad values", () => {
  const cases = [
    [{ version: 2 }, /unsupported version/],
    [{ firmware: { minBatteryPercent: 150 } }, /between 0 and 100/],
    [{ firmware: { attemptsPerTarget: 0 } }, /between 1 and 10/],
    [{ firmware: { sources: { interface: { provider: "github", repo: "no-slash" } } } }, /owner\/name/],
    [{ firmware: { sources: { interface: { provider: "s3", repo: "a/b" } } } }, /must be "github"/],
    [{ firmware: { sources: { interface: { provider: "github", repo: "a/b", assetPattern: "(" } } } }, /invalid regular expression/],
    [{ credentials: { github: { token: 42 } } }, /string or null/],
    [[], /JSON object/],
  ];
  for (const [doc, re] of cases) {
    const { errors } = validateRaw(doc);
    assert.ok(errors.some((e) => re.test(e.message)), `${JSON.stringify(doc)} should fail with ${re}`);
  }
});

test("the published schema and the validator know the same keys", () => {
  const props = (o) => Object.keys(o.properties).sort();
  const s = CONFIG_JSON_SCHEMA.properties;
  assert.deepEqual(props(CONFIG_JSON_SCHEMA), [...VALIDATOR_KNOWN_KEYS[""]].sort());
  assert.deepEqual(props(s.firmware), [...VALIDATOR_KNOWN_KEYS.firmware].sort());
  assert.deepEqual(props(s.firmware.properties.sources), [...VALIDATOR_KNOWN_KEYS["firmware.sources"]].sort());
  assert.deepEqual(props(s.firmware.properties.sources.properties.interface), [...VALIDATOR_KNOWN_KEYS["firmware.sources.*"]].sort());
  assert.deepEqual(props(s.logging), [...VALIDATOR_KNOWN_KEYS.logging].sort());
  assert.deepEqual(props(s.credentials.properties.github), [...VALIDATOR_KNOWN_KEYS["credentials.github"]].sort());
});

// --- secrets --------------------------------------------------------------

test("a credential cannot be printed by any ordinary means", async () => {
  const r = await load({
    configStdin: true,
    readStdin: async () => JSON.stringify({ credentials: { github: { token: CANARY } } }),
  });
  const token = r.config.credentials.github.token;
  assert.ok(token instanceof Secret);
  assert.equal(token.reveal(), CANARY, "reveal() is the one way in");
  for (const rendering of [
    JSON.stringify(r.config),
    JSON.stringify(printableConfig(r.config)),
    String(token),
    `${token}`,
    util.inspect(r.config, { depth: 10 }),
    util.format("%o %s %j", r.config, token, r.config),
    JSON.stringify(r.layers),
  ]) {
    assert.ok(!rendering.includes(CANARY), `leaked in: ${rendering.slice(0, 80)}…`);
  }
  assert.equal(printableConfig(r.config).credentials.github.token, "<redacted: present>");
});

test("the layer report lists a credential by path, never by value", async () => {
  const r = await load({
    configStdin: true,
    readStdin: async () => JSON.stringify({ credentials: { github: { token: CANARY } } }),
  });
  assert.deepEqual(r.layers.find((l) => l.name === "stdin").keys, ["credentials.github.token"]);
});

test("credentials can never arrive as flags", async () => {
  const r = await load({ flags: { credentials: { github: { token: CANARY } } } });
  assert.ok(r.errors.some((e) => /credentials cannot be supplied as command-line flags/.test(e)));
  assert.equal(r.config.credentials.github.token, null);
});

test("a world-readable file holding a credential is flagged, like ssh does", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permissions only");
  const dir = tmp();
  const loose = writeJson(dir, "loose.json", { credentials: { github: { token: CANARY } } }, 0o644);
  const tight = writeJson(dir, "tight.json", { credentials: { github: { token: CANARY } } }, 0o600);
  const noSecret = writeJson(dir, "plain.json", { firmware: { channel: "beta" } }, 0o644);
  assert.ok((await load({ configPath: loose })).warnings.some((w) => /chmod 600/.test(w)));
  assert.ok(!(await load({ configPath: tight })).warnings.some((w) => /chmod/.test(w)));
  assert.ok(!(await load({ configPath: noSecret })).warnings.some((w) => /chmod/.test(w)));
  // and the warning itself never carries the value
  assert.ok(!(await load({ configPath: loose })).warnings.join().includes(CANARY));
});

test("a blank credential is treated as absent", async () => {
  const r = await load({
    configStdin: true,
    readStdin: async () => JSON.stringify({ credentials: { github: { token: "   " } } }),
  });
  assert.equal(r.config.credentials.github.token, null);
});
