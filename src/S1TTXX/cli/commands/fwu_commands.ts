import { Command } from "commander";

import { logger } from "../../../utils/logger";
import { selectPort } from "../../../utils/port_selector";
import { SerialService } from "../../services/serial";
import { getModel, getMaximumBoardAddress, getSlotIndexMaximum } from "../../../utils/model";
import { MINIMUM_BOARD_ADDRESS, SLOT_INDEX_MINIMUM } from "../../../utils/constants";

import { Channel, TargetKind } from "../../fwu/types";
import { parseVersion, Version } from "../../fwu/version";
import { defaultCacheDir } from "../../fwu/catalog";
import {
  DEFAULT_ATTEMPTS_PER_TARGET,
  EngineOptions,
  EngineReport,
  defaultStateFile,
  runEngine,
} from "../../fwu/engine";
import {
  DEFAULT_MAX_FAILURES,
  DEFAULT_MIN_BATTERY_PERCENT,
  defaultGates,
} from "../../fwu/policy";

/**
 * Headless firmware-update commands.
 *
 * Three verbs, each printing exactly one JSON object to stdout so the kiosk
 * app (and any shell script) can consume them without screen-scraping:
 *
 *   station-cli fw-status   read installed versions + slot condition (offline, read-only)
 *   station-cli fw-plan     status + resolve releases + decide what would be updated
 *   station-cli fw-apply    plan, then flash what the plan says, verifying each device
 *
 * Progress and diagnostics go to stderr (via `--verbose`), never stdout.
 *
 * Exit codes:
 *   0  command completed; for `fw-apply`, every attempted update succeeded
 *   1  the command failed, or at least one update failed
 *   10 `fw-plan --fail-on-pending` only: updates are available but not applied
 */

interface FwuCommonOptions {
  channel?: string;
  boards?: string;
  slots?: string;
  targets?: string;
  githubToken?: string;
  cacheDir?: string;
  stateFile?: string;
  verbose?: boolean;
}

interface FwuApplyOptions extends FwuCommonOptions {
  minBattery?: string;
  maxTargets?: string;
  attempts?: string;
  interChunkDelay?: string;
  dryRun?: boolean;
  force?: boolean;
  allowDowngrade?: boolean;
  maxFailures?: string;
  yes?: boolean;
}

/**
 * Expands `1,4,7-9` into `[1, 4, 7, 8, 9]`.
 *
 * Returns an empty array for an empty/absent spec, which every caller reads as
 * "no filter" rather than "nothing selected".
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

function parseChannel(spec: string | undefined): Channel {
  const value = (spec ?? "stable").trim().toLowerCase();
  if (value === "stable" || value === "release" || value === "prod") return "stable";
  if (value === "beta" || value === "dev" || value === "development") return "beta";
  throw new Error(`Unknown channel "${spec}" (expected stable or beta)`);
}

function parsePositiveInt(spec: string | undefined, fallback: number, what: string): number {
  if (spec === undefined || spec === null || `${spec}`.trim() === "") return fallback;
  const value = Number.parseInt(`${spec}`, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${what} "${spec}"`);
  }
  return value;
}

function resolveCliVersion(program: Command): Version {
  const raw = typeof program.version === "function" ? program.version() : undefined;
  return parseVersion(typeof raw === "string" ? raw : null) ?? [0, 0, 0];
}

/** Emits the report as the command's single stdout document. */
function emit(report: EngineReport): void {
  logger.log(JSON.stringify(report, null, 2));
}

function emitFailure(error: unknown, channel: string): void {
  logger.log(
    JSON.stringify(
      {
        success: false,
        timestamp: new Date().toISOString(),
        channel,
        stationModel: getModel(),
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
}

/**
 * Builds the engine options shared by all three commands, then runs one pass.
 *
 * The serial port is opened once and closed in `finally`, so a failure part
 * way through a run never leaves the port held — the kiosk's slot-poll loop
 * needs it back immediately.
 */
async function runOnce(
  program: Command,
  opts: FwuApplyOptions,
  phase: { online: boolean; apply: boolean }
): Promise<EngineReport> {
  const channel = parseChannel(opts.channel);
  const kinds = parseKinds(opts.targets);
  const boards = parseIndexList(opts.boards, MINIMUM_BOARD_ADDRESS, getMaximumBoardAddress(), "board address");
  const slots = parseIndexList(opts.slots, SLOT_INDEX_MINIMUM, getSlotIndexMaximum(), "slot index");

  const engineOptions: EngineOptions = {
    channel,
    cliVersion: resolveCliVersion(program),
    gates: defaultGates({
      channel,
      cliVersion: resolveCliVersion(program),
      kinds,
      minBatteryPercent: parsePositiveInt(opts.minBattery, DEFAULT_MIN_BATTERY_PERCENT, "--min-battery"),
      maxTargets: parsePositiveInt(opts.maxTargets, 0, "--max-targets"),
      force: opts.force === true,
      allowDowngrade: opts.allowDowngrade === true,
      maxFailures: parsePositiveInt(opts.maxFailures, DEFAULT_MAX_FAILURES, "--max-failures"),
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
    githubToken: opts.githubToken ?? null,
    cacheDir: opts.cacheDir ?? defaultCacheDir(),
    stateFile: opts.stateFile ?? defaultStateFile(),
    apply: phase.apply,
    dryRun: opts.dryRun === true,
    attemptsPerTarget: parsePositiveInt(opts.attempts, DEFAULT_ATTEMPTS_PER_TARGET, "--attempts"),
    verbose: opts.verbose === true,
    interChunkDelayMs: parsePositiveInt(opts.interChunkDelay, 0, "--inter-chunk-delay"),
  };

  const port = await selectPort();
  const service = new SerialService(port);
  await service.connect();
  try {
    return await runEngine(service, getModel(), engineOptions);
  } finally {
    await service.disconnect().catch(() => {});
  }
}

/** Options every fw-* command accepts. */
function withCommonOptions(cmd: Command): Command {
  return cmd
    .option("--channel <channel>", "Release channel: stable or beta", "stable")
    .option("--boards <list>", "Restrict to these board addresses, e.g. 0,2 or 0-2")
    .option("--slots <list>", "Restrict to these slot indices, e.g. 1,4,7-9")
    .option("--targets <list>", "Device classes to consider: interface, powerbank, or both", "interface,powerbank")
    .option("--github-token <token>", "Token for the private firmware repositories (defaults to $GITHUB_TOKEN)")
    .option("--cache-dir <path>", `Where downloaded images are cached (default ${defaultCacheDir()})`)
    .option("--state-file <path>", `Where failure/quarantine state is kept (default ${defaultStateFile()})`)
    .option("--verbose", "Print per-chunk progress to stderr", false);
}

export function registerFwuCommands(program: Command): void {
  // ---- fw-status: what is installed right now -----------------------------
  withCommonOptions(
    program
      .command("fw-status")
      .description(
        "Report the firmware version installed on every interface board and docked powerbank (read-only, no network)"
      )
  ).action(async (opts: FwuCommonOptions) => {
    try {
      const report = await runOnce(program, opts, { online: false, apply: false });
      emit(report);
    } catch (error) {
      emitFailure(error, opts.channel ?? "stable");
      process.exit(1);
    }
  });

  // ---- fw-plan: what would be updated -------------------------------------
  withCommonOptions(
    program
      .command("fw-plan")
      .description(
        "Resolve the newest compatible firmware releases and report what would be updated, without touching any device"
      )
  )
    .option(
      "--min-battery <percent>",
      `Minimum powerbank state of charge required to flash it (default ${DEFAULT_MIN_BATTERY_PERCENT})`,
      String(DEFAULT_MIN_BATTERY_PERCENT)
    )
    .option("--max-targets <n>", "Cap how many devices a run would touch (0 = no cap)", "0")
    .option("--force", "Plan a re-flash even for devices already on the target version", false)
    .option("--allow-downgrade", "Permit flashing an older release over a newer installed build", false)
    .option(
      "--max-failures <n>",
      `Consecutive failures on one version before a device is quarantined (default ${DEFAULT_MAX_FAILURES})`,
      String(DEFAULT_MAX_FAILURES)
    )
    .option("--fail-on-pending", "Exit 10 instead of 0 when updates are available", false)
    .action(async (opts: FwuApplyOptions & { failOnPending?: boolean }) => {
      try {
        const report = await runOnce(program, opts, { online: true, apply: false });
        emit(report);
        if (opts.failOnPending && report.summary.updatesPending) {
          process.exit(10);
        }
      } catch (error) {
        emitFailure(error, opts.channel ?? "stable");
        process.exit(1);
      }
    });

  // ---- fw-apply: do it ----------------------------------------------------
  withCommonOptions(
    program
      .command("fw-apply")
      .description(
        "Update every interface board and docked powerbank that has a newer compatible firmware release"
      )
  )
    .option(
      "--min-battery <percent>",
      `Minimum powerbank state of charge required to flash it (default ${DEFAULT_MIN_BATTERY_PERCENT})`,
      String(DEFAULT_MIN_BATTERY_PERCENT)
    )
    .option("--max-targets <n>", "Cap how many devices this run may touch (0 = no cap)", "0")
    .option(
      "--attempts <n>",
      `Attempts per device before giving up (default ${DEFAULT_ATTEMPTS_PER_TARGET})`,
      String(DEFAULT_ATTEMPTS_PER_TARGET)
    )
    .option(
      "--inter-chunk-delay <ms>",
      "Extra wait between consecutive DATA chunks, forwarded to the flasher. Default 0.",
      "0"
    )
    .option("--dry-run", "Plan and download images, but do not flash anything", false)
    .option("--force", "Re-flash even devices already on the target version", false)
    .option("--allow-downgrade", "Permit flashing an older release over a newer installed build", false)
    .option(
      "--max-failures <n>",
      `Consecutive failures on one version before a device is quarantined (default ${DEFAULT_MAX_FAILURES})`,
      String(DEFAULT_MAX_FAILURES)
    )
    .action(async (opts: FwuApplyOptions) => {
      try {
        const report = await runOnce(program, opts, { online: true, apply: true });
        emit(report);
        if (!report.success) {
          process.exit(1);
        }
      } catch (error) {
        emitFailure(error, opts.channel ?? "stable");
        process.exit(1);
      }
    });
}
