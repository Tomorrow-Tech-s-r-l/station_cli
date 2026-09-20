/**
 * Shared vocabulary for the firmware-update engine.
 *
 * The JSON these types serialise to is a cross-repo contract: the kiosk app
 * (amperry-kiosk-local) parses `fw-status`, `fw-plan` and `fw-apply` output to
 * decide what to report to the cloud and when to retry. Fields may be ADDED
 * freely; renaming or removing one is a breaking change that needs a
 * coordinated `minCliVersion` bump on the kiosk side.
 */

import { Version } from "./version";

/** The two updatable device classes in a station. */
export type TargetKind = "interface" | "powerbank";

/** Release channel. `beta` additionally accepts GitHub pre-releases. */
export type Channel = "stable" | "beta";

/**
 * One updatable device.
 *
 * An `interface` target is an S1TTXX board, addressed by `boardAddress`; its
 * `slotIndex` is null because the board owns six slots. A `powerbank` target
 * is a P1TT2C pack, addressed by the 1-based `slotIndex` it is docked in
 * (`boardAddress` is the board that slot belongs to, kept for logging).
 */
export interface TargetRef {
  kind: TargetKind;
  boardAddress: number;
  slotIndex: number | null;
}

/** What the engine found on a device during inventory. */
export interface InstalledTarget extends TargetRef {
  /** Reported firmware name, e.g. `S1TTXX-firmware`. Null when unreadable. */
  name: string | null;
  /** Raw version string as the device reported it. Null when unreadable. */
  versionRaw: string | null;
  /** Parsed `versionRaw`, or null when absent/unparseable. */
  version: Version | null;
  /** Protocol status byte from the read, 0 on success. */
  status: number;
  /** True when the device answered the version query at all. */
  reachable: boolean;
  /** Populated for powerbank targets only. */
  slot?: SlotCondition;
  /** Why the version could not be read, when `reachable` is false. */
  error: string | null;
}

/**
 * Per-slot hardware condition, used by the safety gates. All fields come from
 * the existing `slots` + `status` commands — no new firmware support needed.
 */
export interface SlotCondition {
  /** Pack physically detected in the slot. */
  present: boolean;
  /** Slot reports the pack as retained (not mid-eject). */
  locked: boolean;
  /** State of charge, 0-100. Null when the pack did not answer. */
  powerLevel: number | null;
  /** Pack is actively charging. */
  charging: boolean;
  /** Pack reported a low-voltage condition; never flash one of these. */
  lowVoltage: boolean;
  /** Pack serial, when known. */
  powerbankId: string | null;
}

/** A firmware build available for download. */
export interface ReleaseCandidate {
  kind: TargetKind;
  /** GitHub release tag, e.g. `v1.4.2`. */
  tag: string;
  version: Version;
  /** True when GitHub marks the release as a pre-release. */
  prerelease: boolean;
  /** Name of the raw `.bin` asset the flasher consumes. */
  assetName: string;
  /** API URL used to download the asset (works for private repos). */
  assetUrl: string;
  assetSizeBytes: number;
  /** Minimum station-cli version this firmware requires, when declared. */
  minCliVersion: Version | null;
}

/** Why a target was excluded from the plan. Stable, greppable tokens. */
export type SkipReason =
  | "UP_TO_DATE"
  | "NEWER_THAN_RELEASE"
  | "NO_RELEASE"
  | "UNREADABLE_VERSION"
  | "UNREACHABLE"
  | "SLOT_EMPTY"
  | "SLOT_UNLOCKED"
  | "BATTERY_TOO_LOW"
  | "BATTERY_UNKNOWN"
  | "LOW_VOLTAGE"
  | "CLI_TOO_OLD"
  | "VERSION_OVERFLOW"
  | "QUARANTINED"
  | "FILTERED_OUT"
  | "MAX_TARGETS_REACHED";

/** One decided item: either an update to perform or a documented skip. */
export interface PlanItem {
  target: TargetRef;
  /** Human-facing label, e.g. `interface board 2` or `powerbank slot 13`. */
  label: string;
  installedVersion: string | null;
  candidateVersion: string | null;
  candidateTag: string | null;
  /** True when this item will be flashed. */
  update: boolean;
  /** Set when `update` is false. */
  skipReason: SkipReason | null;
  /** Free-text detail for the skip, e.g. the measured battery level. */
  detail: string | null;
}

/** Full plan: everything the engine looked at, with a verdict per target. */
export interface UpdatePlan {
  channel: Channel;
  cliVersion: string;
  /** Items in execution order: interface boards first, then powerbanks. */
  items: PlanItem[];
  /** Convenience counts so callers do not have to fold `items` themselves. */
  summary: {
    total: number;
    toUpdate: number;
    skipped: number;
    interfaceToUpdate: number;
    powerbankToUpdate: number;
  };
  /** Non-fatal problems encountered while building the plan. */
  warnings: string[];
}

/** Outcome of flashing a single target. */
export interface ApplyItemResult {
  target: TargetRef;
  label: string;
  fromVersion: string | null;
  toVersion: string;
  tag: string;
  success: boolean;
  /** Attempts spent, including the successful one. */
  attempts: number;
  durationMs: number;
  /** Version read back after the flash; null when the read-back failed. */
  verifiedVersion: string | null;
  error: { stage: string; code?: number; message: string } | null;
}

/** Per-target failure bookkeeping, persisted between runs. */
export interface QuarantineEntry {
  /** Consecutive failed attempts. */
  failures: number;
  /** ISO timestamp of the last failure. */
  lastFailureAt: string;
  /** Version that failed, so a new release clears the quarantine. */
  lastFailedVersion: string;
}

/** Shape of the engine's on-disk state file. */
export interface EngineState {
  version: 1;
  quarantine: Record<string, QuarantineEntry>;
}
