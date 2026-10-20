import * as fs from "node:fs";
import * as path from "node:path";

import { SerialService } from "../services/serial";
import { runStationFirmwareUpdate } from "../cli/commands/firmware_update";
import { runPbFirmwareUpdate } from "../cli/commands/pb_firmware_update";
import { PbFirmwareCommand } from "../cli/commands/pb_firmware";
import { mapSlotToBoard } from "../utils/slot_mapping";
import { debug } from "../../utils/debug";
import { JsonlLog } from "../../utils/jsonl_log";
import { Secret } from "../../config/secret";
import { CompatSourceConfig, DEFAULT_COMPAT_SOURCE, FirmwareSourceConfig } from "../../config/schema";
import { buildInfo, bundledCompatibilityFile } from "../../utils/build_info";
import { ComponentId, ReleaseChannel, parseSemVer } from "../../compat/semver";
import { CompatibilityDoc, InstalledComponent, interpretInstalled, stationChannel } from "../../compat/compatibility";
import { CompatLoad, loadCompatibility } from "../../compat/source";

import {
  ApplyItemResult,
  Channel,
  EngineState,
  InstalledTarget,
  PlanItem,
  ReleaseCandidate,
  SkipReason,
  TargetKind,
  UpdatePlan,
} from "./types";
import { formatVersion, parseVersion, toHeaderWord, Version } from "./version";
import { COMPONENT_OF, CatalogOptions, ensureImage, resolveCandidate } from "./catalog";
import {
  collectInventory,
  Inventory,
  InventoryFilter,
  readInterfaceVersion,
  readPackCharge,
  readPowerbankCondition,
} from "./inventory";
import {
  GateVerdict,
  PolicyGates,
  buildPlan,
  emptyState,
  evaluateTarget,
  recordFailure,
  recordSuccess,
  slotGateVerdict,
  summarizeItems,
  targetKey,
  targetLabel,
} from "./policy";

/**
 * Wires the pieces together: inventory → catalog → plan → (optionally) flash.
 *
 * Everything that DECIDES lives in `policy.ts` and is pure. This file only
 * executes, and adds the safety that only exists at execution time:
 *
 *  - an interrupted flash is counted as a failure on the next run (F5);
 *  - each pack is re-checked immediately before its flash, with the same gates
 *    the plan used, plus an identity check against the pack that was planned (F4);
 *  - a board whose own update failed does not have its packs attempted, since
 *    a board sitting in its bootloader cannot relay to them (F3);
 *  - no new device is started once the run's time budget is spent (F8).
 */

/** Time to let a device settle after it resets into its new application. */
const POST_FLASH_SETTLE_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface EngineOptions {
  channel: Channel;
  cliVersion: Version;
  gates: PolicyGates;
  filter: InventoryFilter;
  /** Resolve releases over the network. False yields a plan with no candidates. */
  online: boolean;
  sources: Partial<Record<TargetKind, FirmwareSourceConfig>>;
  token: Secret | null;
  /** Where compatibility.json is published. Default: release-compatibility-cli's `current`. */
  compat?: CompatSourceConfig;
  /** Last good compatibility.json. Default: `<cacheDir>/compatibility.json`. */
  compatCacheFile?: string;
  /**
   * Loads compatibility.json. Defaults to `loadCompatibility` (published file,
   * then cache, then the bundled copy); tests inject a fixture.
   */
  compatLoader?: () => Promise<CompatLoad>;
  cacheDir: string;
  cacheKeepPerKind: number;
  stateFile: string;
  /** Flash. When false the engine stops after planning (`fw-plan`). */
  apply: boolean;
  /** Plan and download images, but never touch a device. */
  dryRun: boolean;
  attemptsPerTarget: number;
  /** No new device is started after this long. 0 disables. */
  maxDurationMs: number;
  verbose: boolean;
  interChunkDelayMs: number;
  /** Correlation id stamped on every log record and on the report. */
  trace: string;
  log: JsonlLog;
  /**
   * Where releases and images come from. Defaults to GitHub via `catalog.ts`;
   * tests inject a local implementation so the engine runs without a network.
   */
  catalog?: CatalogPort;
  /** Wait after a device resets into its new application. Default 1500 ms. */
  postFlashSettleMs?: number;
  /** Waits before re-sending a DATA chunk the link lost (see session.ts). Tests pass zeros. */
  dataResendBackoffMs?: readonly number[];
  /**
   * True when this process holds the firmware lock. Only then may state be
   * repaired (an interrupted flash recorded as a failure); without it another
   * run could be mid-flash.
   */
  holdsLock: boolean;
}

/** The two catalog operations the engine needs. */
export interface CatalogPort {
  resolve(kind: TargetKind, opts: CatalogOptions): Promise<ReleaseCandidate | null>;
  ensure(candidate: ReleaseCandidate, opts: CatalogOptions): Promise<string>;
}

const githubCatalog: CatalogPort = { resolve: resolveCandidate, ensure: ensureImage };

export interface EngineReport {
  success: boolean;
  timestamp: string;
  /** Correlation id: find every log line of this run with it. */
  trace: string;
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
  /**
   * The compatibility data this run decided with (null when no GitHub source
   * needed it). `origin: "none"` means it could not be read and nothing was
   * offered from GitHub.
   */
  compatibility: {
    origin: CompatLoad["origin"];
    location: string | null;
    sequence: number | null;
    generatedAt: string | null;
    error: string | null;
    /** This CLI's own release tag, when the build recorded it. */
    cliTag: string | null;
    /** Whose floors were read: the channel of a station on this update channel. */
    channel: ReleaseChannel;
  } | null;
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

/**
 * Loads engine state. A missing or corrupt file yields an empty state: the
 * state only stops a broken device eating every window, and losing it must
 * never stop the station from updating.
 */
export function loadState(filePath: string): EngineState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as EngineState;
    if (parsed && parsed.version === 1 && parsed.quarantine && typeof parsed.quarantine === "object") {
      return parsed;
    }
  } catch {
    // fall through
  }
  return emptyState();
}

/** Persists engine state atomically (write + rename), best-effort. */
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

export async function runEngine(
  service: SerialService,
  stationModel: string,
  opts: EngineOptions
): Promise<EngineReport> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const log = opts.log;
  const warn = (msg: string, ctx?: Record<string, unknown>) => {
    warnings.push(msg);
    log.warn(msg, ctx);
  };

  log.info("firmware run started", {
    channel: opts.channel,
    apply: opts.apply,
    dryRun: opts.dryRun,
    model: stationModel,
  });

  const state = loadState(opts.stateFile);

  // --- F5: a flash that was interrupted ------------------------------------
  if (state.inFlight) {
    const f = state.inFlight;
    const label = targetLabel(f.target);
    if (opts.holdsLock && opts.apply && !opts.dryRun) {
      recordFailure(state, f.target, f.version, new Date(f.startedAt));
      state.inFlight = null;
      saveState(opts.stateFile, state);
      warn(
        `previous run was interrupted while flashing ${label} to ${f.version} ` +
          `(started ${f.startedAt}); counted as a failure`,
        { device: targetKey(f.target) }
      );
    } else {
      warn(`a previous run was interrupted while flashing ${label} to ${f.version} (started ${f.startedAt})`);
    }
  }

  // fw-plan / fw-apply read a pack's charge only when the plan may flash it
  // (see buildPlan's chargeNeeded): on a full cabinet capped at a few targets
  // a run otherwise spends most of its planning on STATUS reads it never uses.
  // fw-status reports the whole station, so it still reads every pack.
  const deferPackCharge = opts.online;
  const inventory = await collectInventory(service, { ...opts.filter, deferPackCharge });
  for (const w of inventory.warnings) warn(w);

  // --- Catalog ------------------------------------------------------------
  const candidates: Partial<Record<TargetKind, ReleaseCandidate | null>> = {};
  const sourceConfigured: Partial<Record<TargetKind, boolean>> = {};
  const catalogWarnings: string[] = [];
  const catalogOpts: CatalogOptions = {
    channel: opts.channel,
    sources: opts.sources,
    token: opts.token,
    cliVersion: opts.cliVersion,
    cacheDir: opts.cacheDir,
    cacheKeepPerKind: opts.cacheKeepPerKind,
    warnings: catalogWarnings,
    releaseCache: new Map(),
  };

  for (const kind of opts.gates.kinds) sourceConfigured[kind] = !!opts.sources[kind];

  // --- Compatibility data -------------------------------------------------
  //
  // Read once per run, only when a GitHub source needs it: a `dir` source
  // never consults it, and fw-status is offline by definition. An injected
  // catalog (tests) brings its own release selection, and gets compatibility
  // data only when a loader is injected with it.
  let compat: CompatLoad | null = null;
  let boardVersions: InstalledTarget[] = inventory.interfaces;
  let packVersions: InstalledTarget[] = inventory.powerbanks;
  const needsCompat =
    opts.online &&
    (!opts.catalog || !!opts.compatLoader) &&
    opts.gates.kinds.some((k) => opts.sources[k] && opts.sources[k]!.provider !== "dir");
  if (needsCompat) {
    compat = await (opts.compatLoader ?? (() => defaultCompatLoad(opts, catalogWarnings)))();
    catalogOpts.compat = compat;
    if (compat.doc) {
      // Pack images are judged against the boards they sit in; a run limited
      // to powerbanks has not read those yet.
      boardVersions =
        inventory.interfaces.length || !opts.gates.kinds.includes("powerbank")
          ? inventory.interfaces
          : await readBoardsOfPacks(service, inventory.powerbanks);
      // And board images against every pack docked in them: a run limited
      // to interfaces, or to some slots, has not read all of those.
      packVersions =
        opts.gates.kinds.includes("interface") && (opts.filter.skipPowerbanks || !!opts.filter.slots?.length)
          ? await readDockedPacks(service, opts.filter, catalogWarnings)
          : inventory.powerbanks;
      catalogOpts.installed = installedSet(compat.doc, opts, boardVersions, packVersions);
    }
  }

  // The pack release to fall back to when a board update this run was
  // planned on does not complete (see "Packs once" below). Null: none needed.
  let packFallback: { candidate: ReleaseCandidate | null; warnings: string[] } | null = null;
  if (opts.online) {
    // Interface first: a pack image must also suit the board release this
    // run may flash under it, not only the one the board runs now.
    const order = [...opts.gates.kinds].sort((a, b) => (a === "interface" ? -1 : b === "interface" ? 1 : 0));
    for (const kind of order) {
      if (!opts.sources[kind]) {
        warn(
          `no firmware source configured for ${kind} devices — set firmware.sources.${kind} ` +
            `(see: station-cli config check)`
        );
        candidates[kind] = null;
        continue;
      }
      const board = candidates.interface;
      const catalog = opts.catalog ?? githubCatalog;
      const boardEntry =
        kind === "powerbank" && compat?.doc && board?.compat && catalogOpts.installed
          ? interpretInstalled(compat.doc, COMPONENT_OF.interface, formatVersion(board.version), `interface boards once on ${board.tag}`, { tag: board.tag })
          : null;
      if (!boardEntry || !compat?.doc) {
        candidates[kind] = await catalog.resolve(kind, catalogOpts);
        continue;
      }

      // The rule so far: the pack release must suit every board as it runs
      // now AND the board release this run installs. It stays the rule
      // whenever a board update planned this run does not complete.
      const asNow: string[] = [];
      const conservative = await catalog.resolve(kind, {
        ...catalogOpts,
        warnings: asNow,
        installed: [...catalogOpts.installed!, boardEntry],
      });

      // Packs once: P1TT2C releases follow S1TTXX ones (a pack release can
      // need a board at least as new as the one this run installs), so
      // judging packs against boards this run is about to replace offered an
      // intermediate release, and every pack was flashed twice. A board that
      // this run updates is judged as it will be — on the board release —
      // and the result is only used once every one of those updates has
      // been verified (apply, below); otherwise the conservative release is.
      const upgrading = boardsThisRunUpdates(inventory.interfaces, candidates, opts.gates, state, sourceConfigured);
      if (upgrading.size === 0) {
        candidates[kind] = conservative;
        catalogWarnings.push(...asNow);
        continue;
      }
      const after: string[] = [];
      const optimistic = await catalog.resolve(kind, {
        ...catalogOpts,
        warnings: after,
        installed: [
          ...installedSet(
            compat.doc,
            opts,
            boardVersions.filter((b) => !upgrading.has(b.boardAddress)),
            packVersions
          ),
          boardEntry,
        ],
      });
      if (sameRelease(optimistic, conservative)) {
        candidates[kind] = conservative;
        catalogWarnings.push(...asNow);
        continue;
      }
      candidates[kind] = optimistic;
      catalogWarnings.push(...after);
      packFallback = { candidate: conservative, warnings: asNow };
      log.info("pack release chosen for the boards as this run leaves them", {
        boards: [...upgrading],
        boardTag: board!.tag,
        packTag: optimistic?.tag ?? null,
        fallbackTag: conservative?.tag ?? null,
      });
    }
  } else {
    warn("offline mode — no releases were resolved, so nothing can be planned");
  }
  for (const w of catalogWarnings) warn(w);
  const compatSummary = compat
    ? {
        origin: compat.origin,
        location: compat.location,
        sequence: compat.sequence,
        generatedAt: compat.generatedAt,
        error: compat.error,
        cliTag: buildInfo().tag,
        channel: stationChannel(opts.channel),
      }
    : null;

  // --- Plan ---------------------------------------------------------------
  // A pack's charge is read only once the plan would flash it within the
  // per-run cap; a pack that turns out too low frees its place, so plan again
  // until no unread pack is in line. Each round reads at least one new pack.
  let plan: UpdatePlan;
  for (;;) {
    const chargeNeeded: number[] = [];
    plan = buildPlan({
      interfaces: inventory.interfaces,
      powerbanks: inventory.powerbanks,
      candidates,
      gates: opts.gates,
      state,
      warnings,
      sourceConfigured,
      chargeNeeded,
    });
    if (chargeNeeded.length === 0) break;
    for (const slotIndex of chargeNeeded) {
      const p = inventory.powerbanks.find((x) => x.slotIndex === slotIndex);
      if (p) await readPackCharge(service, p);
    }
  }
  const plannedCount = plan.summary.toUpdate;
  // Devices that do need the update but were left for a later run by the
  // per-run cap. They are still pending: without counting them, a capped run
  // (the kiosk passes --max-targets 6, an S1TT30 has 35 devices) reported
  // "nothing pending" while most of the station was still on the old build.
  const deferredByCap = plan.items.filter((i) => i.skipReason === "MAX_TARGETS_REACHED").length;
  log.info("plan built", { ...plan.summary });

  const report: EngineReport = {
    success: true,
    timestamp: new Date().toISOString(),
    trace: opts.trace,
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
    compatibility: compatSummary,
    plan,
    results: [],
    summary: { attempted: 0, succeeded: 0, failed: 0, updatesPending: plannedCount + deferredByCap > 0 },
    warnings,
    error: null,
  };

  if (!opts.apply || plannedCount === 0) {
    log.info("firmware run finished", { planned: plannedCount, applied: false });
    return report;
  }

  // --- Apply --------------------------------------------------------------
  report.applied = !opts.dryRun;
  const failedBoards = new Set<number>();
  const deadline = opts.maxDurationMs > 0 ? startedAt + opts.maxDurationMs : Infinity;
  const packByslot = new Map<number, InstalledTarget>();
  for (const p of inventory.powerbanks) if (p.slotIndex !== null) packByslot.set(p.slotIndex, p);

  const skipAtApply = (item: PlanItem, reason: SkipReason, detail: string) => {
    item.update = false;
    item.skipReason = reason;
    item.detail = detail;
    log.warn(`skipped ${item.label}: ${reason} (${detail})`, {
      device: targetKey(item.target),
      skipReason: reason,
      ...(item.target.slotIndex !== null ? { slot: item.target.slotIndex } : {}),
      board: item.target.boardAddress,
    });
  };

  const queue = plan.items.filter((i) => i.update);
  const boardsPlanned = new Set(
    queue.filter((i) => i.target.kind === "interface").map((i) => i.target.boardAddress)
  );
  const boardsVerified = new Set<number>();
  for (let idx = 0; idx < queue.length; idx++) {
    const item = queue[idx];

    // Packs once, the safe half: the pack release was chosen for the boards
    // as this run leaves them. If any planned board update did not complete,
    // the boards are not all on that release, so the packs go back to the
    // release that suits every board as it runs now — re-planned with the
    // same gates — before the first pack is touched.
    if (item.target.kind === "powerbank" && packFallback && !opts.dryRun) {
      const incomplete = [...boardsPlanned].filter((b) => !boardsVerified.has(b));
      if (incomplete.length) {
        const fallback = packFallback;
        packFallback = null;
        for (const w of fallback.warnings) warn(w);
        candidates.powerbank = fallback.candidate;
        report.available.powerbank = describeCandidate(fallback.candidate);
        warn(
          `interface board(s) ${incomplete.join(", ")} did not complete their update, so packs get ` +
            `${fallback.candidate ? fallback.candidate.tag : "no release"} (compatible with the boards as they run now)`
        );
        for (const rest of queue.slice(idx)) {
          if (rest.target.kind !== "powerbank") continue;
          const planned = packByslot.get(rest.target.slotIndex as number);
          const again = planned
            ? evaluateTarget(planned, { interfaces: [], powerbanks: [], candidates, gates: opts.gates, state, sourceConfigured })
            : null;
          if (!again || !again.update) {
            skipAtApply(
              rest,
              again?.skipReason ?? "NO_RELEASE",
              `board update incomplete; against ${fallback.candidate?.tag ?? "no release"}: ${again?.detail ?? "nothing to install"}`
            );
          } else {
            rest.candidateVersion = again.candidateVersion;
            rest.candidateTag = again.candidateTag;
          }
        }
      }
    }
    if (!item.update) continue; // re-planned away just above

    const candidate = candidates[item.target.kind];
    if (!candidate) continue; // an item only updates when a candidate exists

    // F8: time budget. Checked before starting, never mid-flash.
    if (Date.now() > deadline) {
      const budget = `run time budget of ${Math.round(opts.maxDurationMs / 1000)}s spent`;
      for (const rest of queue.slice(idx)) skipAtApply(rest, "DEADLINE_REACHED", budget);
      warn(`time budget reached; ${queue.length - idx} device(s) left for the next run`);
      break;
    }

    // F3: a board stuck in its bootloader cannot relay to its packs.
    if (item.target.kind === "powerbank" && failedBoards.has(item.target.boardAddress)) {
      skipAtApply(
        item,
        "BOARD_UPDATE_FAILED",
        `interface board ${item.target.boardAddress} failed its own update this run`
      );
      continue;
    }

    if (opts.dryRun) {
      // Still fetch and verify the image: a dry run that skipped the download
      // would say nothing about the half of the pipeline that actually fails
      // in the field. Only the flash is withheld.
      try {
        const imagePath = await (opts.catalog ?? githubCatalog).ensure(candidate, catalogOpts);
        debug.log(`[FWU] (dry-run) would flash ${item.label} → ${candidate.tag} from ${imagePath}`);
      } catch (e) {
        warn(`(dry-run) cannot stage ${candidate.tag} for ${item.label}: ${e instanceof Error ? e.message : String(e)}`);
        report.success = false;
      }
      continue;
    }

    // F4: the plan is minutes old. Re-check the pack with the plan's own gates.
    if (item.target.kind === "powerbank") {
      const planned = packByslot.get(item.target.slotIndex as number);
      const verdict = await reverifyPowerbank(service, item, planned, opts.gates, item.recovery === true);
      if (verdict) {
        skipAtApply(item, "SLOT_CHANGED", `${verdict.reason}: ${verdict.detail}`);
        continue;
      }
    }

    const toVersion = formatVersion(candidate.version);
    log.info(`flashing ${item.label} ${item.installedVersion ?? "?"} → ${toVersion}`, {
      device: targetKey(item.target),
      board: item.target.boardAddress,
      ...(item.target.slotIndex !== null ? { slot: item.target.slotIndex } : {}),
      tag: candidate.tag,
    });

    // F5: record intent before touching the device.
    state.inFlight = { target: item.target, version: toVersion, startedAt: new Date().toISOString() };
    saveState(opts.stateFile, state);

    const result = await applyOne(service, item, candidate, catalogOpts, opts);

    state.inFlight = null;
    report.results.push(result);
    if (result.bootloaderProtocol?.mismatch) {
      warn(
        `${item.label}: bootloader speaks FWU protocol ${result.bootloaderProtocol.reported}, ` +
          `this station-cli speaks ${result.bootloaderProtocol.host}`,
        { device: targetKey(item.target) }
      );
    }
    report.summary.attempted += 1;
    if (result.success) {
      report.summary.succeeded += 1;
      recordSuccess(state, item.target);
      if (item.target.kind === "interface") boardsVerified.add(item.target.boardAddress);
      log.info(`updated ${item.label} → ${toVersion}`, {
        device: targetKey(item.target),
        verified: result.verifiedVersion,
        attempts: result.attempts,
        durationMs: result.durationMs,
        ...(result.chunkRetries ? { chunkRetries: result.chunkRetries } : {}),
      });
    } else {
      report.summary.failed += 1;
      recordFailure(state, item.target, toVersion);
      report.success = false;
      if (item.target.kind === "interface") failedBoards.add(item.target.boardAddress);
      log.error(`update failed for ${item.label} → ${toVersion}`, {
        device: targetKey(item.target),
        stage: result.error?.stage,
        code: result.error?.code,
        error: result.error?.message,
        attempts: result.attempts,
        attemptErrors: result.attemptErrors,
      });
    }
    saveState(opts.stateFile, state);
  }

  plan.summary = summarizeItems(plan.items);
  report.summary.updatesPending =
    deferredByCap > 0 || plannedCount > report.summary.succeeded;
  log.info("firmware run finished", {
    planned: plannedCount,
    ...report.summary,
    durationMs: Date.now() - startedAt,
  });
  return report;
}

/**
 * The interface boards this run will flash: the plan's own verdicts for them,
 * with the same gates, state and cap. Boards are planned before packs and the
 * cap is spent in that order, so a board's verdict never depends on the pack
 * release — which is what lets the pack release be chosen from it.
 */
function boardsThisRunUpdates(
  interfaces: InstalledTarget[],
  candidates: Partial<Record<TargetKind, ReleaseCandidate | null>>,
  gates: PolicyGates,
  state: EngineState,
  sourceConfigured: Partial<Record<TargetKind, boolean>>
): Set<number> {
  const plan = buildPlan({
    interfaces,
    powerbanks: [],
    candidates: { interface: candidates.interface ?? null },
    gates,
    state,
    sourceConfigured,
  });
  return new Set(plan.items.filter((i) => i.update).map((i) => i.target.boardAddress));
}

function sameRelease(a: ReleaseCandidate | null, b: ReleaseCandidate | null): boolean {
  return (a?.tag ?? null) === (b?.tag ?? null) && (a?.assetName ?? null) === (b?.assetName ?? null);
}

function defaultCompatLoad(opts: EngineOptions, warnings: string[]): Promise<CompatLoad> {
  return loadCompatibility({
    source: opts.compat ?? DEFAULT_COMPAT_SOURCE,
    token: opts.token,
    cacheFile: opts.compatCacheFile ?? path.join(opts.cacheDir, "compatibility.json"),
    bundledFile: bundledCompatibilityFile(),
    warnings,
  });
}

/** Board versions for the boards the docked packs sit in (powerbank-only runs). */
async function readBoardsOfPacks(service: SerialService, packs: InstalledTarget[]): Promise<InstalledTarget[]> {
  const boards = [...new Set(packs.filter((p) => p.slot?.present).map((p) => p.boardAddress))].sort((a, b) => a - b);
  const out: InstalledTarget[] = [];
  for (const b of boards) {
    try {
      out.push(await readInterfaceVersion(service, b));
    } catch {
      // unreadable: the pack check fails closed on the missing board version
    }
  }
  return out;
}

/** Every pack docked in the selected boards, whatever the slot filter (interface runs). */
async function readDockedPacks(
  service: SerialService,
  filter: EngineOptions["filter"],
  warnings: string[]
): Promise<InstalledTarget[]> {
  const inv = await collectInventory(service, { boards: filter.boards, skipInterfaces: true, deferPackCharge: true });
  for (const w of inv.warnings) warnings.push(w);
  return inv.powerbanks;
}

/**
 * What is installed, in the terms of compatibility.json: this CLI (by its
 * release tag when the build recorded one), and every distinct firmware
 * version on the boards and the docked packs. A device reporting a bare
 * `X.Y.Z` may run either build of it, whatever the update channel: every
 * reading is checked (interpretInstalled).
 */
export function installedSet(
  doc: CompatibilityDoc,
  opts: Pick<EngineOptions, "cliVersion" | "channel"> & { cliTag?: string | null },
  interfaces: InstalledTarget[],
  powerbanks: InstalledTarget[]
): InstalledComponent[] {
  const out: InstalledComponent[] = [];
  const cliTag = opts.cliTag !== undefined ? opts.cliTag : buildInfo().tag;
  const self = interpretInstalled(doc, "station_cli", formatVersion(opts.cliVersion), "this station-cli", {
    tag: cliTag,
  });
  if (self) out.push(self);

  const group = (component: ComponentId, devices: InstalledTarget[]) => {
    const byVersion = new Map<string, string[]>();
    for (const d of devices) {
      if (!d.reachable || d.inBootloader) continue;
      // The raw string when it is a full version (it may carry `-dev`),
      // else the parsed X.Y.Z.
      const raw = d.versionRaw?.trim() ?? "";
      const reported = parseSemVer(raw) ? raw : d.version ? formatVersion(d.version) : "";
      if (!reported) continue;
      const labels = byVersion.get(reported) ?? [];
      labels.push(targetLabel(d));
      byVersion.set(reported, labels);
    }
    for (const [reported, labels] of byVersion) {
      const inst = interpretInstalled(doc, component, reported, labels.join(", "));
      if (inst) out.push(inst);
    }
  };
  group(COMPONENT_OF.interface, interfaces);
  group(COMPONENT_OF.powerbank, powerbanks);
  return out;
}

function describeCandidate(
  c: ReleaseCandidate | null
): { tag: string; version: string; asset: string } | null {
  if (!c) return null;
  return { tag: c.tag, version: formatVersion(c.version), asset: c.assetName };
}

/**
 * Re-reads a planned pack just before its flash. Returns why it must now be
 * skipped, or null to proceed. Uses `slotGateVerdict` — the same function the
 * plan used — so this check can never be laxer than the plan, and adds an
 * identity check: a different pack in the slot was never evaluated at all.
 */
async function reverifyPowerbank(
  service: SerialService,
  item: PlanItem,
  planned: InstalledTarget | undefined,
  gates: PolicyGates,
  recovery: boolean
): Promise<GateVerdict | null> {
  const mapping = mapSlotToBoard(item.target.slotIndex as number);
  let now;
  try {
    now = await readPowerbankCondition(service, mapping.boardAddress, mapping.slotInBoard);
  } catch (e) {
    return { reason: "UNREACHABLE", detail: `slot could not be re-read: ${e instanceof Error ? e.message : e}` };
  }
  if (!now) return { reason: "UNREACHABLE", detail: "board did not answer the re-check" };

  const verdict = slotGateVerdict(now, gates, { recovery });
  if (verdict) return verdict;

  const plannedId = planned?.slot?.powerbankId ?? null;
  if (plannedId && now.powerbankId && plannedId !== now.powerbankId) {
    return {
      reason: "SLOT_CHANGED",
      detail: `a different pack (${now.powerbankId}) is now in the slot; planned for ${plannedId}`,
    };
  }
  return null;
}

/** One flash attempt of one target through its bootloader. */
function flashOnce(
  service: SerialService,
  item: PlanItem,
  imagePath: string,
  headerVersion: number,
  opts: EngineOptions
) {
  return item.target.kind === "interface"
    ? runStationFirmwareUpdate(service, {
        boardAddress: item.target.boardAddress,
        imagePath,
        version: headerVersion,
        verbose: opts.verbose,
        interChunkDelayMs: opts.interChunkDelayMs,
        dataResendBackoffMs: opts.dataResendBackoffMs,
      })
    : runPbFirmwareUpdate(service, {
        boardAddress: item.target.boardAddress,
        slotInBoard: mapSlotToBoard(item.target.slotIndex as number).slotInBoard,
        imagePath,
        version: headerVersion,
        verbose: opts.verbose,
        interChunkDelayMs: opts.interChunkDelayMs,
        dataResendBackoffMs: opts.dataResendBackoffMs,
      });
}

/**
 * Flashes one target, retrying up to `attemptsPerTarget` times, then reads the
 * version back from the running application. Only that read-back proves the
 * device rebooted into the new image rather than sitting in its bootloader.
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
    imagePath = await (opts.catalog ?? githubCatalog).ensure(candidate, catalogOpts);
  } catch (e) {
    result.error = { stage: "DOWNLOAD", message: e instanceof Error ? e.message : String(e) };
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const headerVersion = toHeaderWord(candidate.version);
  const attempts = Math.max(1, opts.attemptsPerTarget);
  const settle = opts.postFlashSettleMs ?? POST_FLASH_SETTLE_MS;

  const failedAttempt = (attempt: number) => {
    if (!result.error) return;
    (result.attemptErrors ??= []).push({ attempt, ...result.error });
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    result.attempts = attempt;
    if (attempt > 1) failedAttempt(attempt - 1);
    debug.log(`[FWU] ${item.label}: flashing ${candidate.tag} (attempt ${attempt}/${attempts})`);

    // A device that stops answering mid-flash (power loss, a lost reply on the
    // bus) makes the transport throw. That is one failed attempt on one
    // device — never the end of the whole run: without this the exception
    // escaped the engine, the other devices were never attempted and the
    // kiosk got no report at all.
    let flash: Awaited<ReturnType<typeof runStationFirmwareUpdate>>;
    try {
      flash = await flashOnce(service, item, imagePath, headerVersion, opts);
    } catch (e) {
      result.error = {
        stage: "TRANSPORT",
        message: `device stopped answering mid-flash: ${e instanceof Error ? e.message : String(e)}`,
      };
      if (attempt < attempts) await sleep(settle);
      continue;
    }

    // Chunks re-sent or resynced: a flash that succeeded over a lossy link
    // says so, instead of looking exactly like a clean one.
    if (flash.retries > 0) result.chunkRetries = (result.chunkRetries ?? 0) + flash.retries;

    if (flash.blInfo) {
      result.bootloaderProtocol = {
        reported: `${flash.blInfo.blVersionMajor}.${flash.blInfo.blVersionMinor}`,
        host: flash.blInfo.hostProtocol,
        mismatch: flash.blInfo.protocolMismatch,
      };
    }

    if (!flash.success) {
      result.error = flash.error ?? { stage: "UNKNOWN", message: "flash failed" };
      if (attempt < attempts) await sleep(settle);
      continue;
    }

    await sleep(settle);
    const verified = await readBackVersion(service, item);
    result.verifiedVersion = verified;

    if (verified === null) {
      result.error = { stage: "VERIFY", message: "device did not report a version after the flash" };
      if (attempt < attempts) await sleep(settle);
      continue;
    }
    if (verified !== toVersion) {
      result.error = { stage: "VERIFY", message: `device reports ${verified} after flashing ${toVersion}` };
      if (attempt < attempts) await sleep(settle);
      continue;
    }

    result.success = true;
    result.error = null;
    break;
  }
  if (!result.success) failedAttempt(result.attempts);

  result.durationMs = Date.now() - startedAt;
  return result;
}

/** Reads the running application's version back, normalised for comparison. */
async function readBackVersion(service: SerialService, item: PlanItem): Promise<string | null> {
  try {
    if (item.target.kind === "interface") {
      const t = await readInterfaceVersion(service, item.target.boardAddress);
      return t.version ? formatVersion(t.version) : null;
    }
    const mapping = mapSlotToBoard(item.target.slotIndex as number);
    const r = await new PbFirmwareCommand(service).execute(mapping.boardAddress, mapping.slotInBoard);
    if (!r.success || !r.info) return null;
    const v = parseVersion(r.info.version);
    return v ? formatVersion(v) : null;
  } catch {
    return null;
  }
}

export { targetLabel };
