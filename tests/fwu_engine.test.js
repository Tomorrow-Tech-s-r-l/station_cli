/**
 * End-to-end tests of the firmware engine against a fake station.
 *
 * These exercise what only exists at execution time — the safety the pure
 * planner cannot provide, because it happens minutes after the plan:
 *
 *   F3  a board whose own update failed does not have its packs attempted
 *   F4  each pack is re-checked immediately before its flash
 *   F5  a flash interrupted by a kill is counted as a failure next run
 *   F8  no new device starts once the run's time budget is spent
 *
 * plus the happy path, read-back verification and the in-flight marker. Every
 * flash goes through the real FWU session code against fake bootloaders.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FakeStation } = require("./helpers/fake_station");
const { runEngine, loadState, saveState } = require("../dist/S1TTXX/fwu/engine");
const { defaultGates, emptyState, recordFailure } = require("../dist/S1TTXX/fwu/policy");
const { parseVersion } = require("../dist/S1TTXX/fwu/version");
const { JsonlLog } = require("../dist/utils/jsonl_log");
const { setModel } = require("../dist/utils/model");

setModel("S1TT30");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fwu-engine-"));
}

/** A catalog serving local images, so no network is involved. */
function localCatalog(versions) {
  const dir = tmpDir();
  return {
    async resolve(kind) {
      const v = versions[kind];
      if (!v) return null;
      return {
        kind,
        tag: `v${v}`,
        version: parseVersion(v),
        prerelease: false,
        assetName: `${kind}-${v}.bin`,
        assetUrl: "local",
        assetSizeBytes: 0,
        minCliVersion: null,
        digest: null,
      };
    },
    async ensure(candidate) {
      const p = path.join(dir, candidate.assetName);
      const img = Buffer.alloc(200);
      for (let i = 0; i < img.length; i++) img[i] = (i * 7) & 0xff;
      fs.writeFileSync(p, img);
      return p;
    },
  };
}

function options(overrides = {}) {
  const dir = tmpDir();
  const logFile = path.join(dir, "cli.jsonl");
  return {
    channel: "stable",
    cliVersion: [0, 4, 0],
    gates: defaultGates({ cliVersion: [0, 4, 0], maxTargets: 0 }),
    filter: { boards: [0, 1], slots: [] },
    online: true,
    sources: {
      interface: { provider: "github", repo: "acme/iface" },
      powerbank: { provider: "github", repo: "acme/pack" },
    },
    token: null,
    cacheDir: path.join(dir, "cache"),
    cacheKeepPerKind: 2,
    stateFile: path.join(dir, "state.json"),
    apply: true,
    dryRun: false,
    attemptsPerTarget: 1,
    maxDurationMs: 0,
    verbose: false,
    interChunkDelayMs: 0,
    trace: "fwu-test01",
    log: new JsonlLog(logFile, { cat: "firmware", svc: "fwu_engine", trace: "fwu-test01" }),
    holdsLock: true,
    postFlashSettleMs: 0,
    catalog: localCatalog({ interface: "3.1.0", powerbank: "3.0.4" }),
    logFile,
    ...overrides,
  };
}

const pack = (id, extra = {}) => ({ id, version: "3.0.3", level: 85, ...extra });
const item = (report, label) => report.plan.items.find((i) => i.label === label);

test("happy path: board then pack are flashed, and each is verified by read-back", async () => {
  const station = new FakeStation({
    boards: { 0: { version: "3.0.3", slots: [pack("PB0001")] } },
  });
  const report = await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));

  assert.equal(report.success, true);
  assert.equal(report.trace, "fwu-test01");
  assert.deepEqual(
    report.results.map((r) => [r.label, r.success, r.verifiedVersion]),
    [
      ["interface board 0", true, "3.1.0"],
      ["powerbank slot 1", true, "3.0.4"],
    ]
  );
  assert.equal(report.summary.updatesPending, false);
});

test("the board is always flashed before its packs", async () => {
  const station = new FakeStation({
    boards: { 0: { version: "3.0.3", slots: [pack("PB0001")] } },
  });
  await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));
  const firstBoardFrame = station.log.findIndex((e) => e.cmd >= 0x60 && e.cmd <= 0x66);
  const firstPackFrame = station.log.findIndex((e) => e.cmd >= 0x10 && e.cmd <= 0x16);
  assert.ok(firstBoardFrame >= 0 && firstPackFrame > firstBoardFrame);
});

test("F3: packs on a board whose update failed are not attempted", async () => {
  const station = new FakeStation({
    boards: {
      0: { version: "3.0.3", faults: { failDataAt: 2 }, slots: [pack("PB0001"), pack("PB0002")] },
      1: { version: "3.1.0", slots: [pack("PB0007")] },
    },
  });
  const report = await runEngine(station, "S1TT30", options());

  assert.equal(report.success, false);
  assert.equal(item(report, "powerbank slot 1").skipReason, "BOARD_UPDATE_FAILED");
  assert.equal(item(report, "powerbank slot 2").skipReason, "BOARD_UPDATE_FAILED");
  // No pack frame was ever sent to the failed board …
  assert.equal(station.fwuFramesTo(0, 0), 0);
  assert.equal(station.fwuFramesTo(0, 1), 0);
  // … while the healthy board's pack still got its update.
  assert.equal(report.results.find((r) => r.label === "powerbank slot 7").success, true);
});

test("F3: innocent packs are not charged a quarantine strike for their board's failure", async () => {
  const opts = options({ filter: { boards: [0], slots: [] } });
  const station = new FakeStation({
    boards: { 0: { version: "3.0.3", faults: { failDataAt: 2 }, slots: [pack("PB0001")] } },
  });
  await runEngine(station, "S1TT30", opts);
  const state = loadState(opts.stateFile);
  assert.ok(state.quarantine["interface:board0"], "the board's failure is recorded");
  assert.equal(state.quarantine["powerbank:slot1"], undefined, "the pack is not blamed");
});

test("F4: a pack swapped between planning and flashing is not flashed", async () => {
  const station = new FakeStation(
    { boards: { 0: { version: "3.1.0", slots: [pack("PB0001")] } } },
    {
      // SLOTS #1 is the plan; SLOTS #2 is the re-check just before the flash.
      beforeSlots: (board, n, st) => {
        if (board === 0 && n === 2) st.dock(0, 0, pack("PB9999"));
      },
    }
  );
  const report = await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));

  const it = item(report, "powerbank slot 1");
  assert.equal(it.skipReason, "SLOT_CHANGED");
  assert.match(it.detail, /PB9999/);
  assert.equal(station.fwuFramesTo(0, 0), 0, "the unexpected pack was never touched");
});

test("F4: a pack taken out between planning and flashing is not flashed", async () => {
  const station = new FakeStation(
    { boards: { 0: { version: "3.1.0", slots: [pack("PB0001")] } } },
    { beforeSlots: (b, n, st) => b === 0 && n === 2 && st.dock(0, 0, null) }
  );
  const report = await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));
  const it = item(report, "powerbank slot 1");
  assert.equal(it.skipReason, "SLOT_CHANGED");
  assert.match(it.detail, /SLOT_EMPTY/);
});

test("F4: a pack drained below the floor since planning is not flashed", async () => {
  const station = new FakeStation(
    { boards: { 0: { version: "3.1.0", slots: [pack("PB0001")] } } },
    { beforeSlots: (b, n, st) => b === 0 && n === 2 && st.dock(0, 0, pack("PB0001", { level: 10 })) }
  );
  const report = await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));
  assert.match(item(report, "powerbank slot 1").detail, /BATTERY_TOO_LOW/);
});

test("F4: a pack mid-eject at flash time is not flashed", async () => {
  const station = new FakeStation(
    { boards: { 0: { version: "3.1.0", slots: [pack("PB0001")] } } },
    { beforeSlots: (b, n, st) => b === 0 && n === 2 && st.dock(0, 0, pack("PB0001", { locked: false })) }
  );
  const report = await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));
  assert.match(item(report, "powerbank slot 1").detail, /SLOT_UNLOCKED/);
});

test("F5: an interrupted flash is recorded as a failure by the next run that holds the lock", async () => {
  const opts = options({ filter: { boards: [0], slots: [] } });
  const state = emptyState();
  state.inFlight = {
    target: { kind: "powerbank", boardAddress: 0, slotIndex: 1 },
    version: "3.0.4",
    startedAt: "2026-09-20T02:00:00.000Z",
  };
  saveState(opts.stateFile, state);

  const station = new FakeStation({ boards: { 0: { version: "3.1.0", slots: [] } } });
  const report = await runEngine(station, "S1TT30", opts);

  assert.ok(report.warnings.some((w) => /interrupted while flashing powerbank slot 1/.test(w)));
  const after = loadState(opts.stateFile);
  assert.equal(after.inFlight, null);
  assert.equal(after.quarantine["powerbank:slot1"].failures, 1);
  assert.equal(after.quarantine["powerbank:slot1"].lastFailedVersion, "3.0.4");
});

test("F5: without the lock, an interrupted flash is reported but state is left alone", async () => {
  const opts = options({ filter: { boards: [0], slots: [] }, holdsLock: false, apply: false });
  const state = emptyState();
  state.inFlight = {
    target: { kind: "interface", boardAddress: 0, slotIndex: null },
    version: "3.1.0",
    startedAt: "2026-09-20T02:00:00.000Z",
  };
  saveState(opts.stateFile, state);
  const station = new FakeStation({ boards: { 0: { version: "3.0.3", slots: [] } } });
  const report = await runEngine(station, "S1TT30", opts);
  assert.ok(report.warnings.some((w) => /interrupted/.test(w)));
  assert.ok(loadState(opts.stateFile).inFlight, "a run without the lock must not rewrite state");
});

test("F5: the in-flight marker is cleared after every flash, success or failure", async () => {
  const opts = options({ filter: { boards: [0], slots: [] } });
  const station = new FakeStation({
    boards: { 0: { version: "3.0.3", faults: { corruptCrc: true }, slots: [] } },
  });
  await runEngine(station, "S1TT30", opts);
  assert.equal(loadState(opts.stateFile).inFlight, null);
});

test("F8: the device in progress finishes, but no new device starts past the budget", async () => {
  const station = new FakeStation({
    boards: { 0: { version: "3.0.3", slots: [pack("PB0001")] } },
  });
  // The board's flash alone takes ~1 s (bootloader settle times), so a 100 ms
  // budget is spent by the time the pack's turn comes.
  const report = await runEngine(
    station,
    "S1TT30",
    options({ filter: { boards: [0], slots: [] }, maxDurationMs: 100 })
  );
  assert.deepEqual(
    report.results.map((r) => [r.label, r.success]),
    [["interface board 0", true]],
    "the flash already underway is never cut short"
  );
  assert.equal(item(report, "powerbank slot 1").skipReason, "DEADLINE_REACHED");
  assert.equal(station.fwuFramesTo(0, 0), 0, "the pack was never touched");
  assert.equal(report.summary.updatesPending, true, "the pack is left for the next run");
  assert.ok(report.warnings.some((w) => /time budget reached/.test(w)));
});

test("a device that reboots into the wrong version is a failure, not a success", async () => {
  const station = new FakeStation({
    boards: { 0: { version: "3.0.3", slots: [] } },
  });
  station.boards.get(0).reportsVersion = "3.0.9";
  const report = await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));
  const r = report.results[0];
  assert.equal(r.success, false);
  assert.equal(r.error.stage, "VERIFY");
  assert.match(r.error.message, /3\.0\.9/);
});

test("a missing source is reported as NO_SOURCE with the setting to fix", async () => {
  const station = new FakeStation({ boards: { 0: { version: "3.0.3", slots: [] } } });
  const report = await runEngine(
    station,
    "S1TT30",
    options({ filter: { boards: [0], slots: [] }, sources: {} })
  );
  const it = item(report, "interface board 0");
  assert.equal(it.skipReason, "NO_SOURCE");
  assert.match(it.detail, /firmware\.sources\.interface/);
});

test("the plan summary is recomputed after last-second skips", async () => {
  const station = new FakeStation(
    { boards: { 0: { version: "3.1.0", slots: [pack("PB0001")] } } },
    { beforeSlots: (b, n, st) => b === 0 && n === 2 && st.dock(0, 0, null) }
  );
  const report = await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));
  const counted = report.plan.items.filter((i) => i.update).length;
  assert.equal(report.plan.summary.toUpdate, counted);
});

test("every run leaves a structured, traceable log", async () => {
  const opts = options({ filter: { boards: [0], slots: [] } });
  const station = new FakeStation({ boards: { 0: { version: "3.0.3", slots: [] } } });
  await runEngine(station, "S1TT30", opts);
  const records = fs.readFileSync(opts.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(records.length >= 3);
  for (const r of records) {
    assert.equal(r.v, 1);
    assert.equal(r.src, "station-cli");
    assert.equal(r.trace, "fwu-test01");
    assert.match(r.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
  assert.ok(records.some((r) => /updated interface board 0/.test(r.msg)));
});

test("a quarantined device is skipped, and a fresh release lifts the quarantine", async () => {
  const opts = options({ filter: { boards: [0], slots: [] } });
  const state = emptyState();
  for (let i = 0; i < 3; i++) {
    recordFailure(state, { kind: "interface", boardAddress: 0, slotIndex: null }, "3.1.0");
  }
  saveState(opts.stateFile, state);
  const station = new FakeStation({ boards: { 0: { version: "3.0.3", slots: [] } } });
  let report = await runEngine(station, "S1TT30", opts);
  assert.equal(item(report, "interface board 0").skipReason, "QUARANTINED");

  report = await runEngine(
    new FakeStation({ boards: { 0: { version: "3.0.3", slots: [] } } }),
    "S1TT30",
    { ...opts, catalog: localCatalog({ interface: "3.2.0" }) }
  );
  assert.equal(report.results[0].success, true);
});

// --- F13: devices stuck in their bootloader -------------------------------

test("F13: a board stuck in its bootloader is found and flashed back to life", async () => {
  const station = new FakeStation({
    boards: { 0: { version: "3.0.3", faults: { noValidApp: true }, slots: [] } },
  });
  const report = await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));
  const inv = report.inventory.interfaces[0];
  assert.equal(inv.inBootloader, true);
  const it = item(report, "interface board 0");
  assert.equal(it.update, true);
  assert.equal(it.recovery, true, "planned as a recovery, not a routine update");
  assert.deepEqual(
    report.results.map((r) => [r.label, r.success, r.verifiedVersion]),
    [["interface board 0", true, "3.1.0"]]
  );
});

test("F13: a pack stuck in its bootloader is recovered even though its charge cannot be read", async () => {
  const station = new FakeStation({
    boards: { 0: { version: "3.1.0", slots: [pack("PB0001", { faults: { noValidApp: true } })] } },
  });
  const report = await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));
  assert.equal(report.inventory.powerbanks[0].inBootloader, true);
  assert.equal(report.inventory.powerbanks[0].slot.powerLevel, null);
  assert.deepEqual(
    report.results.map((r) => [r.label, r.success, r.verifiedVersion]),
    [["powerbank slot 1", true, "3.0.4"]]
  );
});

test("F13: a board with no bootloader either is still unreachable, and never flashed", async () => {
  const station = new FakeStation({ boards: { 0: { version: "3.0.3", dead: true, slots: [] } } });
  const report = await runEngine(station, "S1TT30", options({ filter: { boards: [0], slots: [] } }));
  assert.equal(item(report, "interface board 0").skipReason, "UNREACHABLE");
  assert.equal(report.results.length, 0);
});

test("F13: a recovery that keeps failing is quarantined like any other flash", async () => {
  const opts = options({ filter: { boards: [0], slots: [] }, gates: defaultGates({ cliVersion: [0, 4, 0], maxTargets: 0, maxFailures: 2 }) });
  const faults = { noValidApp: true, corruptCrc: true };
  for (let run = 0; run < 2; run++) {
    await runEngine(new FakeStation({ boards: { 0: { version: "3.0.3", faults, slots: [] } } }), "S1TT30", opts);
  }
  const report = await runEngine(
    new FakeStation({ boards: { 0: { version: "3.0.3", faults, slots: [] } } }),
    "S1TT30",
    opts
  );
  assert.equal(item(report, "interface board 0").skipReason, "QUARANTINED");
});

test("F5 + F13: an interrupted flash is counted, and the stranded device recovered, in one run", async () => {
  const opts = options({ filter: { boards: [0], slots: [] } });
  const state = emptyState();
  state.inFlight = {
    target: { kind: "interface", boardAddress: 0, slotIndex: null },
    version: "3.1.0",
    startedAt: "2026-09-20T02:00:00.000Z",
  };
  saveState(opts.stateFile, state);

  // What the interrupted flash left behind: a board with an erased header.
  const station = new FakeStation({
    boards: { 0: { version: "3.0.3", faults: { noValidApp: true }, slots: [] } },
  });
  const report = await runEngine(station, "S1TT30", opts);

  assert.ok(report.warnings.some((w) => /interrupted while flashing interface board 0/.test(w)));
  assert.equal(report.results[0].success, true, "and the board is running again");
  const after = loadState(opts.stateFile);
  assert.equal(after.inFlight, null);
  assert.equal(after.quarantine["interface:board0"], undefined, "a success clears the failure");
});
