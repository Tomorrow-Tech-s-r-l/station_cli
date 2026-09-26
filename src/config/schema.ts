import * as os from "node:os";
import * as path from "node:path";

import { Secret } from "./secret";

/**
 * The station-cli configuration document.
 *
 * One JSON shape, assembled from several layers (see `loader.ts`). This file is
 * the single definition of what the document may contain: the TypeScript
 * types, the defaults, the validator and the published JSON Schema all live
 * here, side by side, so they cannot drift apart unnoticed — and a test checks
 * the schema and the validator agree.
 *
 * ## What belongs here, and what must never
 * The binary is published. Its built-in defaults therefore contain no
 * deployment knowledge: no organisation, no repository names, no hosts, no
 * credentials. Everything specific to a deployment — where firmware comes from,
 * where state lives, the token that reads private releases — arrives from
 * outside at run time.
 */

export const CONFIG_VERSION = 1;

export type Channel = "stable" | "beta";
export type FirmwareKind = "interface" | "powerbank";

/** Where one device class's firmware images come from. */
export interface FirmwareSourceConfig {
  /** Only `github` today; the field exists so others can be added without a schema break. */
  provider: "github";
  /** `owner/name` of the repository whose Releases carry the images. */
  repo: string;
  /** Regex (source text, case-insensitive) an asset name must match. Defaults per device class. */
  assetPattern?: string;
  /**
   * Extra regex of asset names to refuse. ADDS to the built-in floor, which
   * always rejects `merged` and `bootloader` images — config can tighten that
   * rule but never loosen it, because a merged image streamed through the
   * update path bricks the device.
   */
  rejectPattern?: string;
}

export interface FirmwareConfig {
  channel: Channel;
  minBatteryPercent: number;
  maxTargets: number;
  /** No new device is started once a run has lasted this long. 0 disables. */
  maxDurationSeconds: number;
  attemptsPerTarget: number;
  maxFailures: number;
  cacheDir: string;
  /** Images kept per device class after a run; older ones are pruned. */
  cacheKeepPerKind: number;
  stateFile: string;
  /** Held for the whole of a flash. `null` derives `<dir of stateFile>/fwu.lock`. */
  lockFile: string | null;
  sources: Partial<Record<FirmwareKind, FirmwareSourceConfig>>;
}

export interface LoggingConfig {
  /** Append structured JSONL records here. `null` disables. */
  jsonlFile: string | null;
}

export interface CredentialsConfig {
  github: { token: Secret | null };
}

export interface StationCliConfig {
  version: 1;
  firmware: FirmwareConfig;
  logging: LoggingConfig;
  credentials: CredentialsConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function xdg(envVar: string, fallback: string[]): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.homedir(), ...fallback);
}

/**
 * Built-in defaults. Generic by construction: XDG paths, conservative safety
 * limits, and no firmware sources at all — a deployment must say where its
 * firmware lives.
 */
export function defaultConfig(): StationCliConfig {
  return {
    version: CONFIG_VERSION,
    firmware: {
      channel: "stable",
      minBatteryPercent: 30,
      maxTargets: 6,
      maxDurationSeconds: 20 * 60,
      attemptsPerTarget: 2,
      maxFailures: 3,
      cacheDir: path.join(xdg("XDG_CACHE_HOME", [".cache"]), "station-cli", "firmware"),
      cacheKeepPerKind: 2,
      stateFile: path.join(
        xdg("XDG_STATE_HOME", [".local", "state"]),
        "station-cli",
        "fwu-state.json"
      ),
      lockFile: null,
      sources: {},
    },
    logging: { jsonlFile: null },
    credentials: { github: { token: null } },
  };
}

/** The lock path actually used: explicit, or next to the state file. */
export function effectiveLockFile(firmware: FirmwareConfig): string {
  return firmware.lockFile ?? path.join(path.dirname(firmware.stateFile), "fwu.lock");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  /** JSON path, e.g. `firmware.sources.interface.repo`. */
  path: string;
  message: string;
}

const KNOWN_KEYS: Record<string, readonly string[]> = {
  "": ["$schema", "version", "firmware", "logging", "credentials"],
  firmware: [
    "channel",
    "minBatteryPercent",
    "maxTargets",
    "maxDurationSeconds",
    "attemptsPerTarget",
    "maxFailures",
    "cacheDir",
    "cacheKeepPerKind",
    "stateFile",
    "lockFile",
    "sources",
  ],
  "firmware.sources": ["interface", "powerbank"],
  "firmware.sources.*": ["provider", "repo", "assetPattern", "rejectPattern"],
  logging: ["jsonlFile"],
  credentials: ["github"],
  "credentials.github": ["token"],
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks a raw (pre-merge or merged) document. Returns hard errors and, for
 * keys the schema does not know, warnings — an unknown key in a hand-edited
 * config file is almost always a typo that would otherwise be silently ignored.
 */
export function validateRaw(doc: unknown): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (p: string, m: string) => errors.push({ path: p || "(root)", message: m });

  if (!isObject(doc)) {
    err("", "configuration must be a JSON object");
    return { errors, warnings };
  }

  const unknown = (obj: Record<string, unknown>, scope: string, known: readonly string[]) => {
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) {
        warnings.push({
          path: scope ? `${scope}.${key}` : key,
          message: "unknown key (typo?) — ignored",
        });
      }
    }
  };
  unknown(doc, "", KNOWN_KEYS[""]);

  if (doc.version !== undefined && doc.version !== CONFIG_VERSION) {
    err("version", `unsupported version ${JSON.stringify(doc.version)} (this CLI reads version ${CONFIG_VERSION})`);
  }

  const num = (obj: Record<string, unknown>, key: string, scope: string, min: number, max: number) => {
    const v = obj[key];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      err(`${scope}.${key}`, `must be an integer between ${min} and ${max}`);
    }
  };
  const str = (obj: Record<string, unknown>, key: string, scope: string, nullable = false) => {
    const v = obj[key];
    if (v === undefined) return;
    if (nullable && v === null) return;
    if (typeof v !== "string" || !v.trim()) {
      err(`${scope}.${key}`, nullable ? "must be a non-empty string or null" : "must be a non-empty string");
    }
  };
  const regex = (obj: Record<string, unknown>, key: string, scope: string) => {
    const v = obj[key];
    if (v === undefined) return;
    if (typeof v !== "string" || !v) {
      err(`${scope}.${key}`, "must be a non-empty regular expression");
      return;
    }
    try {
      new RegExp(v, "i");
    } catch (e) {
      err(`${scope}.${key}`, `invalid regular expression: ${(e as Error).message}`);
    }
  };

  if (doc.firmware !== undefined) {
    if (!isObject(doc.firmware)) {
      err("firmware", "must be an object");
    } else {
      const f = doc.firmware;
      unknown(f, "firmware", KNOWN_KEYS.firmware);
      if (f.channel !== undefined && f.channel !== "stable" && f.channel !== "beta") {
        err("firmware.channel", 'must be "stable" or "beta"');
      }
      num(f, "minBatteryPercent", "firmware", 0, 100);
      num(f, "maxTargets", "firmware", 0, 1000);
      num(f, "maxDurationSeconds", "firmware", 0, 24 * 60 * 60);
      num(f, "attemptsPerTarget", "firmware", 1, 10);
      num(f, "maxFailures", "firmware", 1, 100);
      num(f, "cacheKeepPerKind", "firmware", 1, 100);
      str(f, "cacheDir", "firmware");
      str(f, "stateFile", "firmware");
      str(f, "lockFile", "firmware", true);

      if (f.sources !== undefined) {
        if (!isObject(f.sources)) {
          err("firmware.sources", "must be an object");
        } else {
          unknown(f.sources, "firmware.sources", KNOWN_KEYS["firmware.sources"]);
          for (const kind of ["interface", "powerbank"] as const) {
            const s = f.sources[kind];
            const scope = `firmware.sources.${kind}`;
            if (s === undefined) continue;
            if (!isObject(s)) {
              err(scope, "must be an object");
              continue;
            }
            unknown(s, scope, KNOWN_KEYS["firmware.sources.*"]);
            if (s.provider !== "github") err(`${scope}.provider`, 'must be "github"');
            if (typeof s.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repo)) {
              err(`${scope}.repo`, 'must be "owner/name"');
            }
            regex(s, "assetPattern", scope);
            regex(s, "rejectPattern", scope);
          }
        }
      }
    }
  }

  if (doc.logging !== undefined) {
    if (!isObject(doc.logging)) {
      err("logging", "must be an object");
    } else {
      unknown(doc.logging, "logging", KNOWN_KEYS.logging);
      str(doc.logging, "jsonlFile", "logging", true);
    }
  }

  if (doc.credentials !== undefined) {
    if (!isObject(doc.credentials)) {
      err("credentials", "must be an object");
    } else {
      unknown(doc.credentials, "credentials", KNOWN_KEYS.credentials);
      const gh = doc.credentials.github;
      if (gh !== undefined) {
        if (!isObject(gh)) {
          err("credentials.github", "must be an object");
        } else {
          unknown(gh, "credentials.github", KNOWN_KEYS["credentials.github"]);
          const t = gh.token;
          if (t !== undefined && t !== null && typeof t !== "string") {
            err("credentials.github.token", "must be a string or null");
          }
        }
      }
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Published JSON Schema
// ---------------------------------------------------------------------------

const source = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "repo"],
  properties: {
    provider: { const: "github" },
    repo: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
    assetPattern: { type: "string", minLength: 1, description: "Case-insensitive regex an asset name must match." },
    rejectPattern: {
      type: "string",
      minLength: 1,
      description: "Extra regex of asset names to refuse; adds to the built-in merged/bootloader floor.",
    },
  },
};

const int = (minimum: number, maximum: number, description: string) => ({
  type: "integer",
  minimum,
  maximum,
  description,
});

/** JSON Schema (2020-12) for the configuration document. Printed by `config schema`. */
export const CONFIG_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/Tomorrow-Tech-s-r-l/station_cli/config.schema.json",
  title: "station-cli configuration",
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    version: { const: CONFIG_VERSION },
    firmware: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { enum: ["stable", "beta"] },
        minBatteryPercent: int(0, 100, "Minimum powerbank state of charge to flash it."),
        maxTargets: int(0, 1000, "Devices one run may touch; 0 means no cap."),
        maxDurationSeconds: int(0, 86400, "No new device is started after this long; 0 disables."),
        attemptsPerTarget: int(1, 10, "Attempts per device before giving up."),
        maxFailures: int(1, 100, "Consecutive failures on one version before quarantine."),
        cacheDir: { type: "string", minLength: 1 },
        cacheKeepPerKind: int(1, 100, "Cached images kept per device class."),
        stateFile: { type: "string", minLength: 1 },
        lockFile: { type: ["string", "null"], minLength: 1 },
        sources: {
          type: "object",
          additionalProperties: false,
          properties: { interface: source, powerbank: source },
        },
      },
    },
    logging: {
      type: "object",
      additionalProperties: false,
      properties: { jsonlFile: { type: ["string", "null"], minLength: 1 } },
    },
    credentials: {
      type: "object",
      additionalProperties: false,
      properties: {
        github: {
          type: "object",
          additionalProperties: false,
          properties: { token: { type: ["string", "null"] } },
        },
      },
    },
  },
} as const;

/** Keys the validator knows, exported so a test can prove the schema agrees. */
export const VALIDATOR_KNOWN_KEYS = KNOWN_KEYS;
