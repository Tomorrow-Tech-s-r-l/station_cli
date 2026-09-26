import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { secretFrom } from "./secret";
import {
  CONFIG_VERSION,
  StationCliConfig,
  defaultConfig,
  validateRaw,
} from "./schema";

/**
 * Assembles the effective configuration from up to seven layers, lowest to
 * highest precedence, deep-merged:
 *
 *   1 defaults   built in, generic, publishable
 *   2 system     /etc/station-cli/config.json              (station-wide)
 *   3 user       $XDG_CONFIG_HOME/station-cli/config.json  (per operator)
 *   4 env        STATION_CLI_* variables (and GITHUB_TOKEN)
 *   5 file       --config <path>, or $STATION_CLI_CONFIG
 *   6 stdin      --config-stdin                            (programmatic callers)
 *   7 flags      individual options such as --channel      (never credentials)
 *
 * ## Why stdin is the contract for secrets
 * Anything in argv is world-readable through /proc/<pid>/cmdline, so a
 * credential must never ride on a flag — layer 7 structurally cannot carry one.
 * Environment variables are better but are inherited by every child process.
 * stdin is read once, by this process only, and is neither in argv nor passed
 * on. That is why the kiosk app pipes its credentials in as JSON.
 *
 * Every layer is validated on its own before merging, so an error names the
 * layer it came from ("stdin: firmware.channel must be …") rather than being
 * attributed to the merged result.
 */

export type LayerName = "defaults" | "system" | "user" | "env" | "file" | "stdin" | "flags";

export interface LayerReport {
  name: LayerName;
  path: string | null;
  applied: boolean;
  /** Leaf keys this layer set. Credential keys are listed by path, never value. */
  keys: string[];
  note?: string;
}

export interface LoadedConfig {
  config: StationCliConfig;
  layers: LayerReport[];
  warnings: string[];
  errors: string[];
}

type Raw = Record<string, unknown>;

export interface LoadOptions {
  /** --config */
  configPath?: string;
  /** --config-stdin */
  configStdin?: boolean;
  /** Layer 7. Built by the CLI from explicit flags; must never contain credentials. */
  flags?: Raw;
  /** Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  systemConfigPath?: string;
  userConfigPath?: string;
  readStdin?: () => Promise<string>;
}

/** How long `--config-stdin` waits for the caller to finish writing and close stdin. */
const STDIN_TIMEOUT_MS = 10_000;

const isObject = (v: unknown): v is Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge; objects merge key by key, everything else (arrays, null) replaces. */
export function deepMerge(base: Raw, over: Raw): Raw {
  const out: Raw = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key] as Raw, value) : value;
  }
  return out;
}

function leafPaths(obj: Raw, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || key === "$schema") continue;
    const p = prefix ? `${prefix}.${key}` : key;
    if (isObject(value) && Object.keys(value).length > 0) out.push(...leafPaths(value, p));
    else out.push(p);
  }
  return out;
}

export function defaultSystemConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.STATION_CLI_SYSTEM_CONFIG?.trim() || "/etc/station-cli/config.json";
}

export function defaultUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "station-cli", "config.json");
}

/**
 * Layer 4. Explicit STATION_CLI_* names win; the AMPERRY_FWU_* names are read
 * as aliases so an installation configured before the rename keeps working;
 * GITHUB_TOKEN / GH_TOKEN are honoured last as the conventional fallbacks.
 */
export function envLayer(env: NodeJS.ProcessEnv): Raw {
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = env[n];
      if (v !== undefined && v.trim()) return v.trim();
    }
    return undefined;
  };
  const firmware: Raw = {};
  const cacheDir = pick("STATION_CLI_FWU_CACHE_DIR", "AMPERRY_FWU_CACHE_DIR");
  const stateFile = pick("STATION_CLI_FWU_STATE_FILE", "AMPERRY_FWU_STATE_FILE");
  const lockFile = pick("STATION_CLI_FWU_LOCK_FILE");
  if (cacheDir) firmware.cacheDir = cacheDir;
  if (stateFile) firmware.stateFile = stateFile;
  if (lockFile) firmware.lockFile = lockFile;

  const layer: Raw = {};
  if (Object.keys(firmware).length) layer.firmware = firmware;

  const jsonl = pick("STATION_CLI_LOG_JSONL");
  if (jsonl) layer.logging = { jsonlFile: jsonl };

  const token = pick("STATION_CLI_GITHUB_TOKEN", "AMPERRY_FWU_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN");
  if (token) layer.credentials = { github: { token } };
  return layer;
}

/** Reads all of stdin, refusing a terminal and bounding the wait. */
export async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      "--config-stdin expects a JSON document piped on stdin, but stdin is a terminal"
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      process.stdin.pause();
      reject(
        new Error(
          `--config-stdin: no end of input after ${STDIN_TIMEOUT_MS / 1000}s — ` +
            "the caller must close stdin after writing the JSON"
        )
      );
    }, STDIN_TIMEOUT_MS);
    process.stdin.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function parseJson(text: string, where: string): Raw {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${where}: not valid JSON (${(e as Error).message})`);
  }
  if (!isObject(parsed)) throw new Error(`${where}: must be a JSON object`);
  const { $schema: _ignored, ...rest } = parsed;
  return rest;
}

function hasCredential(raw: Raw): boolean {
  const c = raw.credentials;
  return isObject(c) && isObject(c.github) && typeof c.github.token === "string" && !!c.github.token;
}

/**
 * Warns when a file holding a credential can be read by other users — the
 * check `ssh` applies to private keys. Warning rather than refusing, so a
 * misconfigured station degrades loudly instead of stopping.
 */
function permissionWarning(filePath: string, raw: Raw): string | null {
  if (process.platform === "win32" || !hasCredential(raw)) return null;
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return (
        `${filePath} contains a credential but is readable by other users ` +
        `(mode ${mode.toString(8).padStart(3, "0")}); run: chmod 600 ${filePath}`
      );
    }
  } catch {
    // stat failures are reported when the file is read
  }
  return null;
}

/** Assembles, validates and returns the effective configuration. */
export async function loadConfig(opts: LoadOptions = {}): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  const warnings: string[] = [];
  const errors: string[] = [];
  const layers: LayerReport[] = [];
  let merged: Raw = defaultConfig() as unknown as Raw;
  layers.push({ name: "defaults", path: null, applied: true, keys: [] });

  const apply = (name: LayerName, filePath: string | null, raw: Raw) => {
    const { errors: e, warnings: w } = validateRaw(raw);
    for (const i of e) errors.push(`${name}${filePath ? ` (${filePath})` : ""}: ${i.path} ${i.message}`);
    for (const i of w) warnings.push(`${name}${filePath ? ` (${filePath})` : ""}: ${i.path} ${i.message}`);
    merged = deepMerge(merged, raw);
    layers.push({ name, path: filePath, applied: true, keys: leafPaths(raw) });
  };

  const optionalFile = (name: LayerName, filePath: string) => {
    if (!fs.existsSync(filePath)) {
      layers.push({ name, path: filePath, applied: false, keys: [], note: "not present" });
      return;
    }
    try {
      const raw = parseJson(fs.readFileSync(filePath, "utf8"), `${name} config ${filePath}`);
      const w = permissionWarning(filePath, raw);
      if (w) warnings.push(w);
      apply(name, filePath, raw);
    } catch (e) {
      errors.push((e as Error).message);
      layers.push({ name, path: filePath, applied: false, keys: [], note: "unreadable" });
    }
  };

  optionalFile("system", opts.systemConfigPath ?? defaultSystemConfigPath(env));
  optionalFile("user", opts.userConfigPath ?? defaultUserConfigPath(env));

  const envRaw = envLayer(env);
  if (Object.keys(envRaw).length) apply("env", null, envRaw);
  else layers.push({ name: "env", path: null, applied: false, keys: [], note: "no STATION_CLI_* variables set" });

  // Layer 5: an explicit file is required to exist — asking for a config that
  // is not there is a mistake worth stopping on, unlike the optional layers.
  const explicit = opts.configPath ?? env.STATION_CLI_CONFIG?.trim();
  if (explicit) {
    const filePath = path.resolve(explicit);
    try {
      const raw = parseJson(fs.readFileSync(filePath, "utf8"), `--config ${filePath}`);
      const w = permissionWarning(filePath, raw);
      if (w) warnings.push(w);
      apply("file", filePath, raw);
    } catch (e) {
      errors.push((e as Error).message.startsWith("--config") ? (e as Error).message : `--config ${filePath}: ${(e as Error).message}`);
      layers.push({ name: "file", path: filePath, applied: false, keys: [], note: "unreadable" });
    }
  }

  if (opts.configStdin) {
    try {
      const text = await (opts.readStdin ?? readAllStdin)();
      if (text.trim()) apply("stdin", null, parseJson(text, "--config-stdin"));
      else layers.push({ name: "stdin", path: null, applied: false, keys: [], note: "empty" });
    } catch (e) {
      errors.push((e as Error).message);
      layers.push({ name: "stdin", path: null, applied: false, keys: [], note: "unreadable" });
    }
  }

  if (opts.flags && Object.keys(opts.flags).length) {
    if (isObject(opts.flags.credentials)) {
      // Defence in depth: the CLI never builds such a layer, but if a future
      // change tried to, refuse rather than let a secret come from argv.
      errors.push("flags: credentials cannot be supplied as command-line flags");
    } else {
      apply("flags", null, opts.flags);
    }
  }

  // Normalise into the typed shape, wrapping the credential so it can never be
  // printed by accident from here on.
  const f = merged.firmware as Raw;
  const creds = merged.credentials as Raw | undefined;
  const gh = isObject(creds?.github) ? (creds!.github as Raw) : {};
  const config: StationCliConfig = {
    version: CONFIG_VERSION,
    firmware: {
      ...(f as unknown as StationCliConfig["firmware"]),
      sources: { ...(isObject(f.sources) ? (f.sources as Raw) : {}) } as StationCliConfig["firmware"]["sources"],
    },
    logging: { ...(merged.logging as StationCliConfig["logging"]) },
    credentials: { github: { token: secretFrom(gh.token) } },
  };

  return { config, layers, warnings, errors };
}

/**
 * The effective configuration as printable JSON. The credential is already a
 * `Secret`, so this is safe by construction; it additionally records whether a
 * credential is present, which is the one fact about it worth showing.
 */
export function printableConfig(config: StationCliConfig): Raw {
  const printable = JSON.parse(JSON.stringify(config)) as Raw;
  const token = config.credentials.github.token;
  (printable.credentials as Raw).github = {
    token: token ? "<redacted: present>" : null,
  };
  return printable;
}
