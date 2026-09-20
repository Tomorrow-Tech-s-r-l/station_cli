import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SerialService } from "../services/serial";
import { runStationFirmwareUpdate } from "../cli/commands/firmware_update";
import { runPbFirmwareUpdate } from "../cli/commands/pb_firmware_update";
import { mapSlotToBoard } from "../utils/slot_mapping";
import { debug } from "../../utils/debug";

import {
  ApplyItemResult,
  Channel,
  EngineState,
  PlanItem,
  ReleaseCandidate,
  TargetKind,
  UpdatePlan,
} from "./types";
import { formatVersion, parseVersion, toHeaderWord, Version } from "./version";
import {
  CatalogOptions,
  defaultCacheDir,
  ensureImage,
  resolveCandidate,
  resolveToken,
} from "./catalog";
import { collectInventory, Inventory, InventoryFilter, readInterfaceVersion } from "./inventory";
import {
  PolicyGates,
  buildPlan,
  emptyState,
  recordFailure,
  recordSuccess,
  targetLabel,
} from "./policy";
import { PbFirmwareCommand } from "../cli/commands/pb_firmware";

/**
 * Wires the pieces together: inventory → catalog → plan → (optionally) flash.
 *
 * Everything the kiosk app and an operator over SSH need is reachable from
 * here; the CLI commands in `cli.ts` are thin wrappers that pick which phases
 * to run and print the report as JSON.
 */

/** Time to let a board settle after it resets into its new application. */
const POST_FLASH_SETTLE_MS = 1_500;

/** Attempts per target, including the first. */
export const DEFAULT_ATTEMPTS_PER_TARGET = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface EngineOptions {
  channel: Channel;
  cliVersion: Version;
  gates: PolicyGates;
  filter: InventoryFilter;
  /** Resolve releases over the network. False yields a plan with no candidates. */
  online: boolean;
  githubToken?: string | null;
  cacheDir?: string;
  stateFile?: string;
  /** Flash. When false the engine stops after planning (`fw-plan`). */
  apply: boolean;
  /** Plan and download images but never touch a device. */
  dryRun: boolean;
  attemptsPerTarget: number;
  verbose: boolean;
  /** Extra wait between DATA chunks, forwarded to the flashers. */
  interChunkDelayMs: number;
}

export interface EngineReport {
  success: boolean;
  timestamp: string;
  channel: Channel;
  cliVersion: string;
  stationModel: string;
  online: boolean;
  dryRun: boolean;
  applied: boolean;
  inventory: {
    interfaces: Inventory["interfaces"];
    powerbanks: Inventory["powerbanks"];
  };
  available: Partial<Record<TargetKind, { tag: string; version: string; asset: string } | null>>;
  plan: UpdatePlan;
  results: ApplyItemResult[];
  summary: {
    attempted: number;
    succeeded: number;
    failed: number;
    /** True when at least one device still has an update pending. */
    updatesPending: boolean;
  };
  warnings: string[];
  error: string | null;
}

/** Default state-file location; override with `--state-file`. */
export function defaultStateFile(): string {
  const fromEnv = process.env.AMPERRY_FWU_STATE_FILE;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.homedir(), ".amperry", "fwu-state.json");
}

/**
 * Loads the quarantine state.
 *
 * A missing or corrupt file yields an empty state rather than an error: the
 * state is an optimisation (it stops a broken target eating every window), and
 * losing it must never stop the station from updating.
 */
export function loadState(filePath: string): EngineState {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as EngineState;
    if (parsed && parsed.version === 1 && parsed.quarantine && typeof parsed.quarantine === "object") {
      return parsed;
    }
  } catch {
    // fall through
  }
  return emptyState();
}

/** Persists the quarantine state, best-effort. */
export function saveState(filePath: string, state: EngineState): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (e) {
    debug.log(`[FWU] could not persist state to ${filePath}: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Runs the engine end to end.
 *
 * Phases are skippable so one implementation serves all three CLI commands:
 * `fw-status` runs inventory only (`online: false`, `apply: false`),
 * `fw-plan` adds catalog + planning, and `fw-apply` adds execution.
 */
export async function runEngine(
  service: SerialService,
  stationModel: string,
  opts: EngineOptions
): Promise<EngineReport> {
  const warnings: string[] = [];
  const stateFile = opts.stateFile ?? defaultStateFile();
  const state = loadState(stateFile);

  const inventory = await collectInventory(service, opts.filter);
  warnings.push(...inventory.warnings);

  // --- Catalog ------------------------------------------------------------
  const candidates: Partial<Record<TargetKind, ReleaseCandidate | null>> = {};
  const catalogOpts: CatalogOptions = {
    channel: opts.channel,
    token: resolveToken(opts.githubToken),
    cliVersion: opts.cliVersion,
    cacheDir: opts.cacheDir ?? defaultCacheDir(),
    warnings,
  };

  if (opts.online) {
    if (!catalogOpts.token) {
      warnings.push(
        "No GitHub token found (checked --github-token, AMPERRY_FWU_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN). " +
          "The firmware repositories are private, so release lookup will fail."
      );
    }
    for (const kind of opts.gates.kinds) {
      candidates[kind] = await resolveCandidate(kind, catalogOpts);
    }
  } else {
    warnings.push("Offline mode — no releases were resolved, so nothing can be planned.");
  }

  // --- Plan ---------------------------------------------------------------
  const plan = buildPlan({
    interfaces: inventory.interfaces,
    powerbanks: inventory.powerbanks,
    candidates,
    gates: opts.gates,
    state,
    warnings,
  });

  const report: EngineReport = {
    success: true,
    timestamp: new Date().toISOString(),
    channel: opts.channel,
    cliVersion: formatVersion(opts.cliVersion),
    stationModel,
    online: opts.online,
    dryRun: opts.dryRun,
    applied: false,
    inventory: { interfaces: inventory.interfaces, powerbanks: inventory.powerbanks },
    available: {
      interface: describeCandidate(candidates.interface ?? null),
      powerbank: describeCandidate(candidates.powerbank ?? null),
    },
    plan,
    results: [],
    summary: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      updatesPending: plan.summary.toUpdate > 0,
    },
    warnings,
    error: null,
  };

  if (!opts.apply || plan.summary.toUpdate === 0) {
    return report;
  }

  // --- Apply --------------------------------------------------------------
  report.applied = !opts.dryRun;

  for (const item of plan.items.filter((i) => i.update)) {
    const candidate = candidates[item.target.kind];
    if (!candidate) continue; // unreachable: an item only updates when one exists

    if (opts.dryRun) {
      debug.log(`[FWU] (dry-run) would flash ${item.label} → ${candidate.tag}`);
      continue;
    }

    const result = await applyOne(service, item, candidate, catalogOpts, opts);
    report.results.push(result);
    report.summary.attempted += 1;
    if (result.success) {
      report.summary.succeeded += 1;
      recordSuccess(state, item.target);
    } else {
      report.summary.failed += 1;
      recordFailure(state, item.target, formatVersion(candidate.version));
      report.success = false;
    }
    saveState(stateFile, state);
  }

  report.summary.updatesPending =
    plan.summary.toUpdate > report.summary.succeeded;

  return report;
}

function describeCandidate(
  c: ReleaseCandidate | null
): { tag: string; version: string; asset: string } | null {
  if (!c) return null;
  return { tag: c.tag, version: formatVersion(c.version), asset: c.assetName };
}

/**
 * Flashes one target, retrying up to `attemptsPerTarget` times, then reads the
 * version back.
 *
 * The read-back is what makes the result trustworthy: both bootloaders verify
 * the CRC32 before stamping the header, so a successful END already means the
 * bytes landed intact — but only a version query against the *running
 * application* proves the device actually rebooted into it rather than sitting
 * in its bootloader. A flash whose read-back disagrees is reported as a
 * failure so the target is retried next window.
 */
async function applyOne(
  service: SerialService,
  item: PlanItem,
  candidate: ReleaseCandidate,
  catalogOpts: CatalogOptions,
  opts: EngineOptions
): Promise<ApplyItemResult> {
  const startedAt = Date.now();
  const toVersion = formatVersion(candidate.version);
  const result: ApplyItemResult = {
    target: item.target,
    label: item.label,
    fromVersion: item.installedVersion,
    toVersion,
    tag: candidate.tag,
    success: false,
    attempts: 0,
    durationMs: 0,
    verifiedVersion: null,
    error: null,
  };

  let imagePath: string;
  try {
    imagePath = await ensureImage(candidate, catalogOpts);
  } catch (e) {
    result.error = {
      stage: "DOWNLOAD",
      message: e instanceof Error ? e.message : String(e),
    };
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const headerVersion = toHeaderWord(candidate.version);
  const attempts = Math.max(1, opts.attemptsPerTarget);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    result.attempts = attempt;
    debug.log(
      `[FWU] ${item.label}: flashing ${candidate.tag} (attempt ${attempt}/${attempts})`
    );

    const flash =
      item.target.kind === "interface"
        ? await runStationFirmwareUpdate(service, {
            boardAddress: item.target.boardAddress,
            imagePath,
            version: headerVersion,
            verbose: opts.verbose,
            interChunkDelayMs: opts.interChunkDelayMs,
          })
        : await runPbFirmwareUpdate(service, {
            boardAddress: item.target.boardAddress,
            slotInBoard: mapSlotToBoard(item.target.slotIndex as number).slotInBoard,
            imagePath,
            version: headerVersion,
            verbose: opts.verbose,
            interChunkDelayMs: opts.interChunkDelayMs,
          });

    if (!flash.success) {
      result.error = flash.error ?? { stage: "UNKNOWN", message: "flash failed" };
      // Give the device a moment before retrying; the flashers self-heal a
      // stuck bootloader with a pre-flight EXIT on their next run.
      if (attempt < attempts) await sleep(POST_FLASH_SETTLE_MS);
      continue;
    }

    await sleep(POST_FLASH_SETTLE_MS);
    const verified = await readBackVersion(service, item);
    result.verifiedVersion = verified;

    if (verified === null) {
      result.error = {
        stage: "VERIFY",
        message: "device did not report a version after the flash",
      };
      if (attempt < attempts) await sleep(POST_FLASH_SETTLE_MS);
      continue;
    }
    if (verified !== toVersion) {
      result.error = {
        stage: "VERIFY",
        message: `device reports ${verified} after flashing ${toVersion}`,
      };
      if (attempt < attempts) await sleep(POST_FLASH_SETTLE_MS);
      continue;
    }

    result.success = true;
    result.error = null;
    break;
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/** Reads the running application version back, normalised for comparison. */
async function readBackVersion(
  service: SerialService,
  item: PlanItem
): Promise<string | null> {
  try {
    if (item.target.kind === "interface") {
      const t = await readInterfaceVersion(service, item.target.boardAddress);
      return t.version ? formatVersion(t.version) : null;
    }
    const mapping = mapSlotToBoard(item.target.slotIndex as number);
    const r = await new PbFirmwareCommand(service).execute(
      mapping.boardAddress,
      mapping.slotInBoard
    );
    if (!r.success || !r.info) return null;
    const v = parseVersion(r.info.version);
    return v ? formatVersion(v) : null;
  } catch {
    return null;
  }
}

export { targetLabel };
