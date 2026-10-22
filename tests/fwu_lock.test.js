/**
 * The firmware lock: exclusive while its owner lives, recoverable when it
 * provably does not, and never deleted out from under a new owner.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  acquireLock,
  activeLock,
  readLock,
  staleReason,
  currentBootId,
  FirmwareLockHeldError,
} = require("../dist/S1TTXX/fwu/lock");

const lockPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lock-")), "fwu.lock");

/** A PID that is certainly not running: spawn a process and let it exit. */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(r.stdout.toString());
}

function plant(file, info) {
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, command: "x", startedAt: new Date().toISOString(), host: "h", bootId: currentBootId(), ...info })
  );
}

test("acquiring writes our identity; a second acquirer is refused while we live", () => {
  const file = lockPath();
  const held = acquireLock(file, "fw-apply");
  const info = readLock(file);
  assert.equal(info.pid, process.pid);
  assert.equal(info.command, "fw-apply");
  assert.throws(() => acquireLock(file, "fw-apply"), FirmwareLockHeldError);
  assert.deepEqual(activeLock(file)?.pid, process.pid);
  held.release();
  assert.equal(fs.existsSync(file), false);
  assert.equal(activeLock(file), null);
});

test("the refusal names the holder, so an operator knows what is running", () => {
  const file = lockPath();
  const held = acquireLock(file, "fw-apply --dry-run");
  try {
    acquireLock(file, "fw-apply");
    assert.fail("expected refusal");
  } catch (e) {
    assert.match(e.message, /already in progress \(pid \d+, "fw-apply --dry-run"/);
  } finally {
    held.release();
  }
});

test("a lock whose owner died is taken over, and the reason reported", () => {
  const file = lockPath();
  plant(file, { pid: deadPid() });
  let reason = null;
  const held = acquireLock(file, "fw-apply", (r) => (reason = r));
  assert.match(reason, /no longer running/);
  assert.equal(readLock(file).pid, process.pid);
  held.release();
});

test("a lock from before a reboot is stale even if its PID is reused", (t) => {
  if (!currentBootId()) return t.skip("no boot id on this platform");
  // Our own, very alive, PID — but a different boot.
  const info = { pid: process.pid, startedAt: new Date().toISOString(), bootId: "00000000-0000-0000-0000-000000000000", command: "x", host: "h" };
  assert.match(staleReason(info), /rebooted/);
});

test("a lock older than any legitimate run is stale", () => {
  const info = { pid: process.pid, startedAt: new Date(Date.now() - 7 * 3600 * 1000).toISOString(), bootId: currentBootId(), command: "x", host: "h" };
  assert.match(staleReason(info), /older than any legitimate run/);
});

test("an unreadable lock file is stale rather than blocking forever", () => {
  const file = lockPath();
  fs.writeFileSync(file, "garbage");
  assert.equal(activeLock(file), null);
  const held = acquireLock(file, "fw-apply");
  held.release();
});

test("release never deletes a lock someone else now holds", () => {
  const file = lockPath();
  const held = acquireLock(file, "fw-apply");
  // Simulate another process having taken over after ours was judged stale.
  plant(file, { pid: process.pid, startedAt: "2099-01-01T00:00:00.000Z" });
  held.release();
  assert.equal(fs.existsSync(file), true, "the new owner's lock survives our release");
});

test("release is idempotent", () => {
  const file = lockPath();
  const held = acquireLock(file, "fw-apply");
  held.release();
  held.release();
  assert.equal(fs.existsSync(file), false);
});
