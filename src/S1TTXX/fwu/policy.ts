import {
  Channel,
  EngineState,
  InstalledTarget,
  PlanItem,
  ReleaseCandidate,
  SkipReason,
  SlotCondition,
  TargetKind,
  TargetRef,
  UpdatePlan,
} from "./types";
import {
  Version,
  compareVersions,
  formatVersion,
  overflowsHeaderWord,
} from "./version";

/**
 * The decision engine: pure, synchronous, and free of serial and network I/O
 * so it can be reasoned about and unit-tested directly (`tests/fwu_policy.test.js`).
 *
 * Everything that can talk to hardware lives in `engine.ts`; everything that
 * decides *whether* hardware should be touched lives here. Given the same
 * inventory, candidates, gates and state, this always produces the same plan.
 */

/** Below this state of charge a powerbank is never flashed. */
export const DEFAULT_MIN_BATTERY_PERCENT = 30;

/** Consecutive failures on the same version before a target is quarantined. */
export const DEFAULT_MAX_FAILURES = 3;

export interface PolicyGates {
  channel: Channel;
  cliVersion: Version;
  /** Device classes eligible this run. */
  kinds: TargetKind[];
  /** Minimum state of charge for a powerbank, 0-100. */
  minBatteryPercent: number;
  /** Cap on devices flashed in one run. 0 or negative means no cap. */
  maxTargets: number;
  /** Re-flash even when the installed version already matches. */
  force: boolean;
  /** Permit flashing an older release over a newer installed build. */
  allowDowngrade: boolean;
  /** Consecutive failures tolerated before a target is quarantined. */
  maxFailures: number;
}

export function defaultGates(overrides: Partial<PolicyGates> = {}): PolicyGates {
  return {
    channel: "stable",
    cliVersion: [0, 0, 0],
    kinds: ["interface", "powerbank"],
    minBatteryPercent: DEFAULT_MIN_BATTERY_PERCENT,
    maxTargets: 0,
    force: false,
    allowDowngrade: false,
    maxFailures: DEFAULT_MAX_FAILURES,
    ...overrides,
  };
}

/** Stable identity for a target, used as the quarantine key. */
export function targetKey(t: TargetRef): string {
  return t.kind === "interface"
    ? `interface:board${t.boardAddress}`
    : `powerbank:slot${t.slotIndex}`;
}

/** `interface board 2` / `powerbank slot 13`. */
export function targetLabel(t: TargetRef): string {
  return t.kind === "interface"
    ? `interface board ${t.boardAddress}`
    : `powerbank slot ${t.slotIndex}`;
}

export interface PlanInput {
  interfaces: InstalledTarget[];
  powerbanks: InstalledTarget[];
  /** Best available release per device class; null when none is offered. */
  candidates: Partial<Record<TargetKind, ReleaseCandidate | null>>;
  gates: PolicyGates;
  state: EngineState;
  warnings?: string[];
  /**
   * Whether a firmware source is configured per device class. A class marked
   * false reports NO_SOURCE instead of NO_RELEASE, which tells an operator the
   * fix is configuration rather than a missing release. Omitted means configured.
   */
  sourceConfigured?: Partial<Record<TargetKind, boolean>>;
}

/** A gate verdict: why a device must not be flashed, or null to proceed. */
export interface GateVerdict {
  reason: SkipReason;
  detail: string;
}

/**
 * The physical safety gates for a powerbank, in one place.
 *
 * Used twice: once when the plan is built, and again immediately before each
 * pack is flashed — minutes later, by which time a customer may have taken
 * the pack or returned a different one. Sharing the function guarantees the
 * last-second check can never be laxer than the plan.
 */
export function slotGateVerdict(
  slot: SlotCondition | undefined,
  gates: PolicyGates,
  options: { recovery?: boolean } = {}
): GateVerdict | null {
  if (!slot || !slot.present) {
    return { reason: "SLOT_EMPTY", detail: "no powerbank docked" };
  }
  if (!slot.locked) {
    // A slot mid-eject is about to lose pogo contact. Starting a flash here
    // would drop the link between BEGIN and END and leave the pack's app
    // header erased — i.e. a pack that only boots to its bootloader.
    return { reason: "SLOT_UNLOCKED", detail: "slot is not retaining the pack (mid-eject?)" };
  }
  if (slot.lowVoltage) {
    return { reason: "LOW_VOLTAGE", detail: "pack reports a low-voltage condition" };
  }
  if (slot.powerLevel === null) {
    // A pack stuck in its bootloader cannot report its charge — STATUS is an
    // application command. Refusing to flash it on that ground would leave it
    // stuck for ever. And the usual reason for the floor does not apply: an
    // application flash never writes the bootloader, so a brown-out mid-way
    // leaves the pack exactly where it already is — in its bootloader, still
    // recoverable. A charge that IS known and too low still blocks, below.
    if (options.recovery) return null;
    return { reason: "BATTERY_UNKNOWN", detail: "state of charge could not be read" };
  }
  if (slot.powerLevel < gates.minBatteryPercent) {
    // The pack runs its own MCU off the cell during the flash; a brown-out
    // mid-write is the one failure the bootloader cannot recover from
    // unattended.
    return {
      reason: "BATTERY_TOO_LOW",
      detail: `${slot.powerLevel}% < required ${gates.minBatteryPercent}%`,
    };
  }
  return null;
}

/**
 * Builds the ordered plan.
 *
 * ## Ordering is a safety property, not a preference
 * Interface boards are always planned before powerbanks. The station decodes
 * powerbank responses by strict payload-length equality, so a powerbank
 * carrying a newer response shape than the board it is docked in makes every
 * dock interaction fail. Updating the board first means the pair is never
 * worse than "board ahead of pack", which both sides tolerate.
 *
 * Within a class, targets are ordered by board address then slot index, so a
 * run that is cut short (power loss, `--max-targets`) always makes progress
 * from the same end rather than re-rolling a random subset.
 */
export function buildPlan(input: PlanInput): UpdatePlan {
  const { gates, state } = input;
  const warnings = input.warnings ?? [];
  const items: PlanItem[] = [];

  const interfaces = [...input.interfaces].sort((a, b) => a.boardAddress - b.boardAddress);
  const powerbanks = [...input.powerbanks].sort(
    (a, b) => (a.slotIndex ?? 0) - (b.slotIndex ?? 0)
  );

  let budget = gates.maxTargets > 0 ? gates.maxTargets : Number.POSITIVE_INFINITY;

  const consider = (installed: InstalledTarget) => {
    const item = evaluate(installed, input, gates, state);
    // The budget is spent only by items that would actually be flashed, and
    // only once the rest of the gates have already passed — so a capped run
    // does not "use up" its budget on targets that were going to be skipped.
    if (item.update) {
      if (budget <= 0) {
        item.update = false;
        item.skipReason = "MAX_TARGETS_REACHED";
        item.detail = `run capped at ${gates.maxTargets} target(s)`;
      } else {
        budget -= 1;
      }
    }
    items.push(item);
  };

  for (const i of interfaces) consider(i);
  for (const p of powerbanks) consider(p);

  return {
    channel: gates.channel,
    cliVersion: formatVersion(gates.cliVersion),
    items,
    summary: summarizeItems(items),
    warnings,
  };
}

/**
 * Counts for a list of plan items. Exported because the engine recomputes the
 * summary after a run, when items skipped at the last second (slot changed,
 * board failed, deadline) have been re-marked — so the printed plan stays
 * internally consistent.
 */
export function summarizeItems(items: PlanItem[]): UpdatePlan["summary"] {
  const toUpdate = items.filter((i) => i.update);
  return {
    total: items.length,
    toUpdate: toUpdate.length,
    skipped: items.length - toUpdate.length,
    interfaceToUpdate: toUpdate.filter((i) => i.target.kind === "interface").length,
    powerbankToUpdate: toUpdate.filter((i) => i.target.kind === "powerbank").length,
  };
}

/** Applies every gate to one target, in order of increasing cost to evaluate. */
function evaluate(
  installed: InstalledTarget,
  input: PlanInput,
  gates: PolicyGates,
  state: EngineState
): PlanItem {
  const target: TargetRef = {
    kind: installed.kind,
    boardAddress: installed.boardAddress,
    slotIndex: installed.slotIndex,
  };
  const candidate = input.candidates[installed.kind] ?? null;

  const base: PlanItem = {
    target,
    label: targetLabel(target),
    installedVersion: installed.version ? formatVersion(installed.version) : installed.versionRaw,
    candidateVersion: candidate ? formatVersion(candidate.version) : null,
    candidateTag: candidate ? candidate.tag : null,
    update: false,
    skipReason: null,
    detail: null,
  };

  const skip = (reason: SkipReason, detail: string | null = null): PlanItem => ({
    ...base,
    update: false,
    skipReason: reason,
    detail,
  });

  if (!gates.kinds.includes(installed.kind)) {
    return skip("FILTERED_OUT", `${installed.kind} targets excluded this run`);
  }

  // --- Physical condition gates (powerbanks only) -------------------------
  //
  // Checked before the version comparison so an empty slot reports SLOT_EMPTY
  // rather than the UNREADABLE_VERSION that trivially follows from it.
  // A device whose application is silent but whose bootloader answers has no
  // valid application: an earlier flash was interrupted. It is flashed back to
  // life (F13) — the version checks below do not apply, as there is no
  // installed version to compare, but availability and quarantine still do.
  const recovery = installed.inBootloader === true;

  if (installed.kind === "powerbank") {
    const verdict = slotGateVerdict(installed.slot, gates, { recovery });
    if (verdict) return skip(verdict.reason, verdict.detail);
  }

  // --- Reachability and version readability -------------------------------
  if (recovery) {
    // handled below: reachable through its bootloader, no version to read
  } else if (!installed.reachable) {
    return skip("UNREACHABLE", installed.error ?? "device did not answer");
  }
  if (!installed.version && !recovery) {
    // Without a parseable installed version there is no way to tell an update
    // from a downgrade. `--force` is the deliberate escape hatch.
    if (!gates.force) {
      return skip("UNREADABLE_VERSION", installed.error ?? `got "${installed.versionRaw}"`);
    }
  }

  // --- Availability -------------------------------------------------------
  if (!candidate) {
    if (input.sourceConfigured?.[installed.kind] === false) {
      return skip(
        "NO_SOURCE",
        `no firmware source configured for ${installed.kind} devices (set firmware.sources.${installed.kind})`
      );
    }
    return skip("NO_RELEASE", `no ${gates.channel} release offers an image for this device`);
  }
  if (overflowsHeaderWord(candidate.version)) {
    // The app header packs the version into one byte per component; a larger
    // component would be silently truncated and break every later comparison.
    return skip(
      "VERSION_OVERFLOW",
      `release ${candidate.tag} has a component above 255 and cannot be stamped into the app header`
    );
  }

  // --- Version comparison -------------------------------------------------
  if (installed.version && !recovery) {
    const delta = compareVersions(installed.version, candidate.version);
    if (delta === 0 && !gates.force) {
      return skip("UP_TO_DATE", `already on ${formatVersion(candidate.version)}`);
    }
    if (delta > 0 && !gates.allowDowngrade && !gates.force) {
      return skip(
        "NEWER_THAN_RELEASE",
        `installed ${formatVersion(installed.version)} is newer than ${candidate.tag}`
      );
    }
  }

  // --- Quarantine ---------------------------------------------------------
  //
  // A target that has already failed the same version `maxFailures` times is
  // parked until a different release appears. Without this, a genuinely broken
  // pack would be re-flashed at every maintenance window forever, burning the
  // whole window and starving the targets that would have succeeded.
  const entry = state.quarantine[targetKey(target)];
  if (
    entry &&
    entry.failures >= gates.maxFailures &&
    entry.lastFailedVersion === formatVersion(candidate.version) &&
    !gates.force
  ) {
    return skip(
      "QUARANTINED",
      `${entry.failures} consecutive failures on ${entry.lastFailedVersion} (last ${entry.lastFailureAt}); ` +
        `clears when a newer release appears or with --force`
    );
  }

  if (recovery) {
    return {
      ...base,
      update: true,
      skipReason: null,
      detail: "recovery: stuck in its bootloader with no valid application",
      recovery: true,
    };
  }
  return { ...base, update: true, skipReason: null, detail: null };
}

/** Records a failed attempt, bumping the consecutive-failure counter. */
export function recordFailure(
  state: EngineState,
  target: TargetRef,
  version: string,
  at: Date = new Date()
): void {
  const key = targetKey(target);
  const existing = state.quarantine[key];
  const sameVersion = existing && existing.lastFailedVersion === version;
  state.quarantine[key] = {
    failures: sameVersion ? existing.failures + 1 : 1,
    lastFailureAt: at.toISOString(),
    lastFailedVersion: version,
  };
}

/** Clears a target's failure history after a successful flash. */
export function recordSuccess(state: EngineState, target: TargetRef): void {
  delete state.quarantine[targetKey(target)];
}

/** A fresh, empty state document. */
export function emptyState(): EngineState {
  return { version: 1, quarantine: {} };
}
