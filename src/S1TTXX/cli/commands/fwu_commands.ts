import { Command, Option } from "commander";

import { logger } from "../../../utils/logger";
import { selectPort } from "../../../utils/port_selector";
import { SerialService } from "../../services/serial";
import {
  getModel,
  getMaximumBoardAddress,
  getSlotIndexMaximum,
  isS0TTModel,
} from "../../../utils/model";
import { MINIMUM_BOARD_ADDRESS, SLOT_INDEX_MINIMUM } from "../../../utils/constants";
import { JsonlLog, newTraceId } from "../../../utils/jsonl_log";

import { TargetKind } from "../../fwu/types";
import { parseVersion, Version } from "../../fwu/version";
import { EngineOptions, EngineReport, runEngine } from "../../fwu/engine";
import { defaultGates } from "../../fwu/policy";
import { acquireLock, activeLock, FirmwareLockHeldError, HeldLock } from "../../fwu/lock";
import { loadConfig, LoadedConfig } from "../../../config/loader";
import { effectiveLockFile, StationCliConfig } from "../../../config/schema";

/**
 * Headless firmware-update commands.
 *
 *   station-cli fw-status   installed versions + slot condition (no network)
 *   station-cli fw-plan     + resolve releases, decide what would change
 *   station-cli fw-apply    + flash it, verifying every device
 *
 * Each prints exactly one JSON document on stdout. Everything else — progress
 * with --verbose, and the "how to dig further" hints — goes to stderr, so
 * stdout stays machine-parseable.
 *
 * ## Configuration
 * Every setting comes from the layered configuration (see src/config/loader.ts):
 * built-in defaults, /etc/station-cli/config.json, the user's config, STATION_CLI_*
 * environment variables, --config <file>, and --config-stdin. The flags below
 * override single values for one run. Credentials are never accepted as flags —
 * argv is visible to every user on the machine — pass them via --config-stdin.
 *
 * Exit codes:
 *   0  completed; for fw-apply, every attempted update succeeded
 *   1  the command failed, or at least one update failed
 *   10 fw-plan --fail-on-pending only: updates are available but not applied
 */

interface FwuOptions {
  config?: string;
  configStdin?: boolean;
  channel?: string;
  boards?: string;
  slots?: string;
  targets?: string;
  cacheDir?: string;
  stateFile?: string;
  trace?: string;
  verbose?: boolean;
  hints?: boolean;
  githubToken?: string;
  minBattery?: string;
  maxTargets?: string;
  maxDuration?: string;
  attempts?: string;
  maxFailures?: string;
  interChunkDelay?: string;
  dryRun?: boolean;
  force?: boolean;
  allowDowngrade?: boolean;
  failOnPending?: boolean;
}

class UsageError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Expands `1,4,7-9` into `[1, 4, 7, 8, 9]`. An empty/absent spec returns `[]`,
 * which every caller reads as "no filter" rather than "nothing selected".
 */
export function parseIndexList(spec: string | undefined, min: number, max: number, what: string): number[] {
  if (!spec || !spec.trim()) return [];
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number.parseInt(range[1], 10);
      const to = Number.parseInt(range[2], 10);
      if (from > to) throw new Error(`Invalid ${what} range "${piece}" (start above end)`);
      for (let i = from; i <= to; i++) out.add(i);
      continue;
    }
    const single = Number.parseInt(piece, 10);
    if (!Number.isFinite(single)) throw new Error(`Invalid ${what} "${piece}"`);
    out.add(single);
  }
  for (const value of out) {
    if (value < min || value > max) {
      throw new Error(`${what} ${value} is outside the valid range ${min}-${max} for model ${getModel()}`);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Parses `interface,powerbank` (default: both). */
export function parseKinds(spec: string | undefined): TargetKind[] {
  if (!spec || !spec.trim()) return ["interface", "powerbank"];
  const out: TargetKind[] = [];
  for (const part of spec.split(",")) {
    const piece = part.trim().toLowerCase();
    if (!piece) continue;
    if (piece === "interface" || piece === "station" || piece === "board") {
      if (!out.includes("interface")) out.push("interface");
    } else if (piece === "powerbank" || piece === "pb" || piece === "pack") {
      if (!out.includes("powerbank")) out.push("powerbank");
    } else {
      throw new Error(`Unknown target "${piece}" (expected interface or powerbank)`);
    }
  }
  if (out.length === 0) throw new Error("--targets selected nothing");
  return out;
}

/** Accepts the channel aliases the kiosk and installers use. */
export function normaliseChannel(spec: string): "stable" | "beta" {
  const value = spec.trim().toLowerCase();
  if (value === "stable" || value === "release" || value === "prod") return "stable";
  if (value === "beta" || value === "dev" || value === "development") return "beta";
  throw new UsageError(`Unknown channel "${spec}" (expected stable or beta)`);
}

function intFlag(spec: string | undefined, what: string): number | undefined {
  if (spec === undefined) return undefined;
  const value = Number(spec);
  if (!Number.isInteger(value) || value < 0) throw new UsageError(`Invalid ${what} "${spec}"`);
  return value;
}

/**
 * Layer 7 of the configuration: only the options the caller actually passed.
 * Nothing here has a commander default, so an omitted flag cannot silently
 * override a value from a config file.
 */
export function flagsLayer(opts: FwuOptions): Record<string, unknown> {
  const firmware: Record<string, unknown> = {};
  if (opts.channel !== undefined) firmware.channel = normaliseChannel(opts.channel);
  const set = (key: string, value: number | undefined) => {
    if (value !== undefined) firmware[key] = value;
  };
  set("minBatteryPercent", intFlag(opts.minBattery, "--min-battery"));
  set("maxTargets", intFlag(opts.maxTargets, "--max-targets"));
  set("maxDurationSeconds", intFlag(opts.maxDuration, "--max-duration"));
  set("attemptsPerTarget", intFlag(opts.attempts, "--attempts"));
  set("maxFailures", intFlag(opts.maxFailures, "--max-failures"));
  if (opts.cacheDir !== undefined) firmware.cacheDir = opts.cacheDir;
  if (opts.stateFile !== undefined) firmware.stateFile = opts.stateFile;
  return Object.keys(firmware).length ? { firmware } : {};
}

function resolveCliVersion(program: Command): Version {
  const raw = typeof program.version === "function" ? program.version() : undefined;
  return parseVersion(typeof raw === "string" ? raw : null) ?? [0, 0, 0];
}

/**
 * Loads configuration for a command. Also used by the one-shot flashing
 * commands, which need only the lock path and must keep working if the config
 * is broken — hence `tolerant`.
 */
export async function loadCommandConfig(
  opts: Pick<FwuOptions, "config" | "configStdin">,
  flags: Record<string, unknown> = {},
  tolerant = false
): Promise<LoadedConfig> {
  const loaded = await loadConfig({
    configPath: opts.config,
    configStdin: opts.configStdin === true,
    flags,
  });
  if (loaded.errors.length && !tolerant) {
    throw new UsageError("invalid configuration", loaded.errors);
  }
  return loaded;
}

type Phase = { name: "fw-status" | "fw-plan" | "fw-apply"; online: boolean; apply: boolean };

interface RunOutcome {
  report: EngineReport;
  loaded: LoadedConfig;
  config: StationCliConfig;
}

async function runOnce(program: Command, opts: FwuOptions, phase: Phase): Promise<RunOutcome> {
  if (opts.githubToken !== undefined) {
    throw new UsageError(
      "credentials cannot be passed as command-line flags — anything in argv is visible to every " +
        "user on this machine. Pipe them in instead, e.g. " +
        `echo '{"credentials":{"github":{"token":"…"}}}' | station-cli ${phase.name} --config-stdin, ` +
        "or set STATION_CLI_GITHUB_TOKEN."
    );
  }

  // F6: these commands speak the S1TTXX firmware-update protocol. An S0TT
  // gateway would receive frames it cannot interpret.
  if (isS0TTModel(getModel())) {
    throw new UsageError(
      `firmware updates are supported on S1TT stations only (current model: ${getModel()})`
    );
  }

  const loaded = await loadCommandConfig(opts, flagsLayer(opts));
  const config = loaded.config;
  const fw = config.firmware;

  const kinds = parseKinds(opts.targets);
  const boards = parseIndexList(opts.boards, MINIMUM_BOARD_ADDRESS, getMaximumBoardAddress(), "board address");
  const slots = parseIndexList(opts.slots, SLOT_INDEX_MINIMUM, getSlotIndexMaximum(), "slot index");
  const cliVersion = resolveCliVersion(program);
  const trace = opts.trace?.trim() || newTraceId("fwu");
  const log = new JsonlLog(config.logging.jsonlFile, { cat: "firmware", svc: "fwu_engine", trace });

  // The lock. fw-apply holds it for the whole run (a dry run too — it writes
  // the image cache). Read-only commands only check it, so they fail with a
  // clear message instead of a busy serial port.
  const lockFile = effectiveLockFile(fw);
  let held: HeldLock | null = null;
  if (phase.apply) {
    held = acquireLock(lockFile, `${phase.name}${opts.dryRun ? " --dry-run" : ""}`, (reason) => {
      loaded.warnings.push(`took over a stale firmware lock (${reason})`);
      log.warn(`took over a stale firmware lock (${reason})`, { lockFile });
    });
  } else {
    const holder = activeLock(lockFile);
    if (holder) throw new FirmwareLockHeldError(holder, lockFile);
  }

  const engineOptions: EngineOptions = {
    channel: fw.channel,
    cliVersion,
    gates: defaultGates({
      channel: fw.channel,
      cliVersion,
      kinds,
      minBatteryPercent: fw.minBatteryPercent,
      maxTargets: fw.maxTargets,
      force: opts.force === true,
      allowDowngrade: opts.allowDowngrade === true,
      maxFailures: fw.maxFailures,
    }),
    filter: {
      boards,
      slots,
      // A run limited to interface boards does not need the per-slot walk,
      // which is the expensive part of an inventory on a 30-slot cabinet.
      skipPowerbanks: !kinds.includes("powerbank"),
      skipInterfaces: !kinds.includes("interface"),
    },
    online: phase.online,
    sources: fw.sources,
    token: config.credentials.github.token,
    cacheDir: fw.cacheDir,
    cacheKeepPerKind: fw.cacheKeepPerKind,
    stateFile: fw.stateFile,
    apply: phase.apply,
    dryRun: opts.dryRun === true,
    attemptsPerTarget: fw.attemptsPerTarget,
    maxDurationMs: fw.maxDurationSeconds * 1000,
    verbose: opts.verbose === true,
    interChunkDelayMs: intFlag(opts.interChunkDelay, "--inter-chunk-delay") ?? 0,
    trace,
    log,
    holdsLock: held !== null,
  };

  try {
    const port = await selectPort();
    const service = new SerialService(port);
    await service.connect();
    try {
      const report = await runEngine(service, getModel(), engineOptions);
      // Configuration warnings belong in the same list an operator reads.
      report.warnings.unshift(...loaded.warnings);
      return { report, loaded, config };
    } finally {
      await service.disconnect().catch(() => {});
    }
  } finally {
    held?.release();
  }
}

/** One JSON document on stdout — the command's result. */
function emitReport(outcome: RunOutcome): void {
  logger.log(
    JSON.stringify(
      {
        ...outcome.report,
        configLayers: outcome.loaded.layers.filter((l) => l.applied).map((l) => l.name),
      },
      null,
      2
    )
  );
}

function emitFailure(error: unknown, trace: string | undefined): void {
  const out: Record<string, unknown> = {
    success: false,
    timestamp: new Date().toISOString(),
    trace: trace ?? null,
    stationModel: getModel(),
    error: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof UsageError && error.details.length) out.errors = error.details;
  if (error instanceof FirmwareLockHeldError) out.lock = { file: error.lockFile, ...error.info };
  logger.log(JSON.stringify(out, null, 2));
}

/**
 * Tells the operator how to dig further, on stderr. This CLI is published and
 * knows nothing about the application that may be driving it, so every hint
 * names only station-cli itself and its own log file.
 */
function printHints(phase: Phase, outcome: RunOutcome | null, error: unknown, opts: FwuOptions): void {
  if (opts.hints === false) return;
  const lines: string[] = [];
  const trace = outcome?.report.trace ?? opts.trace;
  const jsonl = outcome?.config.logging.jsonlFile ?? null;

  if (error) {
    lines.push(`station-cli ${phase.name}: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError && error.details.length) {
      for (const d of error.details) lines.push(`  - ${d}`);
      lines.push("  check:    station-cli config check");
    }
  } else if (outcome) {
    const s = outcome.report.summary;
    const head =
      phase.apply && s.attempted > 0
        ? `${s.succeeded}/${s.attempted} updated${s.failed ? `, ${s.failed} failed` : ""}`
        : `${outcome.report.plan.summary.toUpdate} update(s) available`;
    lines.push(`station-cli ${phase.name}: ${head} (trace ${outcome.report.trace})`);
    if (outcome.report.warnings.length) {
      lines.push(`  ${outcome.report.warnings.length} warning(s) in the JSON "warnings" field`);
    }
  }

  if (jsonl && trace) {
    lines.push(`  this run: jq -c 'select(.trace=="${trace}")' ${jsonl}`);
    lines.push(`  errors:   jq -c 'select(.lvl=="error")' ${jsonl}`);
  } else if (!jsonl) {
    lines.push("  log:      set logging.jsonlFile (or STATION_CLI_LOG_JSONL) to keep a structured log");
  }
  lines.push("  devices:  station-cli fw-status        config: station-cli config check");
  process.stderr.write(lines.join("\n") + "\n");
}

/** Options every fw-* command accepts. No defaults: omitted means "use config". */
function withCommonOptions(cmd: Command): Command {
  return cmd
    .option("--config <path>", "Read configuration from this JSON file (layer 5)")
    .option("--config-stdin", "Read configuration JSON from stdin — the way to pass credentials (layer 6)")
    .option("--channel <channel>", "Release channel for this run: stable or beta")
    .option("--boards <list>", "Restrict to these board addresses, e.g. 0,2 or 0-2")
    .option("--slots <list>", "Restrict to these slot indices, e.g. 1,4,7-9")
    .option("--targets <list>", "Device classes to consider: interface, powerbank, or both")
    .option("--cache-dir <path>", "Override firmware.cacheDir for this run")
    .option("--state-file <path>", "Override firmware.stateFile for this run")
    .option("--trace <id>", "Correlation id for this run's log records (default: generated)")
    .option("--verbose", "Print per-chunk progress to stderr", false)
    .option("--no-hints", "Do not print the how-to-investigate hints on stderr")
    .addOption(new Option("--github-token <token>").hideHelp());
}

function withPlanningOptions(cmd: Command): Command {
  return cmd
    .option("--min-battery <percent>", "Minimum powerbank state of charge to flash it")
    .option("--max-targets <n>", "Cap how many devices one run may touch (0 = no cap)")
    .option("--force", "Re-flash even devices already on the target version; overrides quarantine", false)
    .option("--allow-downgrade", "Permit flashing an older release over a newer installed build", false)
    .option("--max-failures <n>", "Consecutive failures on one version before a device is quarantined");
}

async function execute(program: Command, opts: FwuOptions, phase: Phase): Promise<void> {
  let outcome: RunOutcome | null = null;
  try {
    outcome = await runOnce(program, opts, phase);
  } catch (error) {
    emitFailure(error, opts.trace);
    printHints(phase, null, error, opts);
    process.exit(1);
  }
  emitReport(outcome);
  printHints(phase, outcome, null, opts);
  if (phase.apply && !outcome.report.success) process.exit(1);
  if (phase.name === "fw-plan" && opts.failOnPending && outcome.report.summary.updatesPending) {
    process.exit(10);
  }
}

export function registerFwuCommands(program: Command): void {
  withCommonOptions(
    program
      .command("fw-status")
      .description(
        "Report the firmware version installed on every interface board and docked powerbank (read-only, no network)"
      )
  ).action((opts: FwuOptions) => execute(program, opts, { name: "fw-status", online: false, apply: false }));

  withPlanningOptions(
    withCommonOptions(
      program
        .command("fw-plan")
        .description(
          "Resolve the newest compatible firmware releases and report what would be updated, without touching any device"
        )
    )
  )
    .option("--fail-on-pending", "Exit 10 instead of 0 when updates are available", false)
    .action((opts: FwuOptions) => execute(program, opts, { name: "fw-plan", online: true, apply: false }));

  withPlanningOptions(
    withCommonOptions(
      program
        .command("fw-apply")
        .description(
          "Update every interface board and docked powerbank that has a newer compatible firmware release"
        )
    )
  )
    .option("--max-duration <seconds>", "Start no new device after this long (0 = no limit)")
    .option("--attempts <n>", "Attempts per device before giving up")
    .option("--inter-chunk-delay <ms>", "Extra wait between consecutive DATA chunks")
    .option("--dry-run", "Plan and download images, but do not flash anything", false)
    .action((opts: FwuOptions) => execute(program, opts, { name: "fw-apply", online: true, apply: true }));
}

/**
 * Holds the firmware lock around a one-shot flashing command
 * (`firmware-update`, `pb-firmware-update`), so the kiosk app — and anything
 * else honouring the lock — stands down while it runs.
 *
 * Configuration is loaded tolerantly: these commands predate the config layer
 * and must keep working on a station whose config file is broken, in which
 * case the default lock path is used and a warning goes to stderr.
 */
export async function withFirmwareLock<T>(command: string, fn: () => Promise<T>): Promise<T> {
  const loaded = await loadCommandConfig({}, {}, true);
  if (loaded.errors.length) {
    process.stderr.write(
      `warning: configuration has errors (${loaded.errors.join("; ")}); using the default lock path\n`
    );
  }
  const lock = acquireLock(effectiveLockFile(loaded.config.firmware), command);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
