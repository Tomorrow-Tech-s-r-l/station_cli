import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The firmware lock: held by exactly one process for the whole of anything
 * that can leave a device mid-flash.
 *
 * Two processes already cannot open the serial port at once — node-serialport
 * opens it exclusively. The lock exists for what that cannot do:
 *
 *  - Tell OTHER programs a flash is in progress. The kiosk app reacts to a
 *    busy serial port by killing station-cli processes and retrying; during a
 *    flash that kill leaves the device's application header erased. The kiosk
 *    reads this file (its path comes from the shared config) and stands down.
 *  - Fail a second caller with a clear message instead of `EAGAIN`.
 *  - Serialise access to the image cache and the state file.
 *
 * The file is created with O_EXCL, so acquisition is atomic. A lock is treated
 * as stale — and silently taken over — when its owner is provably gone: the
 * PID is dead, the machine has rebooted since (boot id differs, which also
 * defeats PID reuse), or it is older than any legitimate run could be.
 */

export interface LockInfo {
  pid: number;
  command: string;
  startedAt: string;
  host: string;
  /** Linux boot id; distinguishes "same PID after a reboot" from the owner. */
  bootId: string | null;
}

/** No legitimate run lasts this long; an older lock is abandoned. */
const MAX_LOCK_AGE_MS = 6 * 60 * 60 * 1000;

export class FirmwareLockHeldError extends Error {
  constructor(readonly info: LockInfo, readonly lockFile: string) {
    super(
      `a firmware update is already in progress (pid ${info.pid}, "${info.command}", ` +
        `since ${info.startedAt}); lock: ${lockFile}`
    );
    this.name = "FirmwareLockHeldError";
  }
}

export function currentBootId(): string | null {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(lockFile: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockInfo;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** Why a lock may be taken over, or null when its owner is still live. */
export function staleReason(info: LockInfo | null, now: number = Date.now()): string | null {
  if (!info) return "unreadable lock file";
  const boot = currentBootId();
  if (info.bootId && boot && info.bootId !== boot) return "machine rebooted since the lock was taken";
  const age = now - Date.parse(info.startedAt);
  if (Number.isFinite(age) && age > MAX_LOCK_AGE_MS) return "lock older than any legitimate run";
  if (!pidAlive(info.pid)) return `owner pid ${info.pid} is no longer running`;
  return null;
}

/** Returns the live holder of the lock, or null when it is free (or stale). */
export function activeLock(lockFile: string): LockInfo | null {
  if (!fs.existsSync(lockFile)) return null;
  const info = readLock(lockFile);
  return staleReason(info) === null ? info : null;
}

export interface HeldLock {
  lockFile: string;
  release(): void;
}

/**
 * Takes the lock or throws `FirmwareLockHeldError`. A stale lock is replaced;
 * `onStale` receives the reason so the caller can log it.
 *
 * The lock is released on `release()` and, as a backstop, on process exit.
 * A SIGKILL leaves the file behind, which the staleness rules then recover.
 */
export function acquireLock(
  lockFile: string,
  command: string,
  onStale?: (reason: string) => void
): HeldLock {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const info: LockInfo = {
    pid: process.pid,
    command,
    startedAt: new Date().toISOString(),
    host: os.hostname(),
    bootId: currentBootId(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o644);
      fs.writeSync(fd, JSON.stringify(info));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 1) throw e;
      const existing = readLock(lockFile);
      const reason = staleReason(existing);
      if (reason === null) throw new FirmwareLockHeldError(existing as LockInfo, lockFile);
      onStale?.(reason);
      fs.rmSync(lockFile, { force: true });
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    // Only remove the file if it is still ours: never delete a lock another
    // process took over after ours was judged stale.
    const current = readLock(lockFile);
    if (current && current.pid === info.pid && current.startedAt === info.startedAt) {
      fs.rmSync(lockFile, { force: true });
    }
  };
  process.on("exit", release);
  return { lockFile, release };
}
