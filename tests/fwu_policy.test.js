/**
 * Unit tests for the firmware-update decision engine.
 *
 * These exercise the pure planner only — no serial port, no network — so they
 * run anywhere with `npm run test:unit` (which builds first, since the tests
 * require the compiled output in dist/).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPlan,
  defaultGates,
  emptyState,
  recordFailure,
  recordSuccess,
  targetKey,
  DEFAULT_MIN_BATTERY_PERCENT,
} = require("../dist/S1TTXX/fwu/policy");
const {
  parseVersion,
  compareVersions,
  toHeaderWord,
  overflowsHeaderWord,
  versionStringFromTag,
  formatVersion,
} = require("../dist/S1TTXX/fwu/version");
const { parseIndexList, parseKinds } = require("../dist/S1TTXX/cli/commands/fwu_commands");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function iface(boardAddress, version, overrides = {}) {
  return {
    kind: "interface",
    boardAddress,
    slotIndex: null,
    name: "S1TTXX-firmware",
    versionRaw: version,
    version: parseVersion(version),
    status: 0,
    reachable: true,
    error: null,
    ...overrides,
  };
}

function pack(slotIndex, version, slotOverrides = {}, overrides = {}) {
  return {
    kind: "powerbank",
    boardAddress: Math.floor((slotIndex - 1) / 6),
    slotIndex,
    name: "P1TT2C-firmware",
    versionRaw: version,
    version: parseVersion(version),
    status: 0,
    reachable: true,
    error: null,
    slot: {
      present: true,
      locked: true,
      powerLevel: 85,
      charging: false,
      lowVoltage: false,
      powerbankId: `PB${slotIndex}`,
      ...slotOverrides,
    },
    ...overrides,
  };
}

function candidate(kind, version, overrides = {}) {
  return {
    kind,
    tag: `v${version}`,
    version: parseVersion(version),
    prerelease: false,
    assetName: `${kind === "interface" ? "S1TTXX" : "P1TT2C"}-firmware-${version}.bin`,
    assetUrl: "https://api.github.com/repos/x/y/releases/assets/1",
    assetSizeBytes: 1024,
    minCliVersion: null,
    ...overrides,
  };
}

function plan(interfaces, powerbanks, candidates, gateOverrides = {}, state = emptyState()) {
  return buildPlan({
    interfaces,
    powerbanks,
    candidates,
    gates: defaultGates({ cliVersion: [0, 3, 0], ...gateOverrides }),
    state,
  });
}

const reasonFor = (result, label) =>
  result.items.find((i) => i.label === label)?.skipReason ?? null;
const itemFor = (result, label) => result.items.find((i) => i.label === label);

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

test("parseVersion accepts the tag shapes the firmware repos produce", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("dev-v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("1.2"), [1, 2, 0]);
  assert.deepEqual(parseVersion("1.2.3-beta.4"), [1, 2, 3]);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("not-a-version"), null);
  assert.equal(parseVersion(null), null);
});

test("versionStringFromTag strips both channel prefixes", () => {
  assert.equal(versionStringFromTag("v2.0.1"), "2.0.1");
  assert.equal(versionStringFromTag("dev-v2.0.1"), "2.0.1");
  assert.equal(versionStringFromTag("2.0.1"), "2.0.1");
});

test("compareVersions orders by major, then minor, then patch", () => {
  assert.ok(compareVersions([1, 0, 0], [0, 9, 9]) > 0);
  assert.ok(compareVersions([1, 2, 3], [1, 2, 4]) < 0);
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

test("toHeaderWord packs one byte per component", () => {
  assert.equal(toHeaderWord([1, 2, 3]), 0x00010203);
  assert.equal(toHeaderWord([0, 4, 0]), 0x00000400);
  // A component above 255 cannot round-trip through the app header.
  assert.equal(overflowsHeaderWord([1, 2, 300]), true);
  assert.equal(overflowsHeaderWord([1, 2, 3]), false);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("interface boards are always planned before powerbanks", () => {
  const result = plan(
    [iface(0, "1.0.0"), iface(1, "1.0.0")],
    [pack(1, "1.0.0"), pack(7, "1.0.0")],
    { interface: candidate("interface", "1.1.0"), powerbank: candidate("powerbank", "1.1.0") }
  );
  const updating = result.items.filter((i) => i.update).map((i) => i.label);
  assert.deepEqual(updating, [
    "interface board 0",
    "interface board 1",
    "powerbank slot 1",
    "powerbank slot 7",
  ]);
});

test("targets are ordered by board then slot so a truncated run makes steady progress", () => {
  const result = plan(
    [iface(2, "1.0.0"), iface(0, "1.0.0")],
    [pack(9, "1.0.0"), pack(2, "1.0.0")],
    { interface: candidate("interface", "1.1.0"), powerbank: candidate("powerbank", "1.1.0") }
  );
  assert.deepEqual(
    result.items.map((i) => i.label),
    ["interface board 0", "interface board 2", "powerbank slot 2", "powerbank slot 9"]
  );
});

// ---------------------------------------------------------------------------
// Version gates
// ---------------------------------------------------------------------------

test("a device already on the release version is skipped as UP_TO_DATE", () => {
  const result = plan([iface(0, "1.1.0")], [], { interface: candidate("interface", "1.1.0") });
  assert.equal(reasonFor(result, "interface board 0"), "UP_TO_DATE");
  assert.equal(result.summary.toUpdate, 0);
});

test("a device ahead of the release is skipped rather than downgraded", () => {
  const result = plan([iface(0, "2.0.0")], [], { interface: candidate("interface", "1.1.0") });
  assert.equal(reasonFor(result, "interface board 0"), "NEWER_THAN_RELEASE");
});

test("--allow-downgrade turns a rollback into a planned update", () => {
  const result = plan(
    [iface(0, "2.0.0")],
    [],
    { interface: candidate("interface", "1.1.0") },
    { allowDowngrade: true }
  );
  assert.equal(itemFor(result, "interface board 0").update, true);
});

test("--force re-flashes a device that is already up to date", () => {
  const result = plan(
    [iface(0, "1.1.0")],
    [],
    { interface: candidate("interface", "1.1.0") },
    { force: true }
  );
  assert.equal(itemFor(result, "interface board 0").update, true);
});

test("no release for a class yields NO_RELEASE, not a crash", () => {
  const result = plan([iface(0, "1.0.0")], [pack(1, "1.0.0")], {
    interface: null,
    powerbank: null,
  });
  assert.equal(reasonFor(result, "interface board 0"), "NO_RELEASE");
  assert.equal(reasonFor(result, "powerbank slot 1"), "NO_RELEASE");
});

test("a release whose version cannot be stamped into the app header is refused", () => {
  const result = plan([iface(0, "1.0.0")], [], {
    interface: candidate("interface", "1.0.300"),
  });
  assert.equal(reasonFor(result, "interface board 0"), "VERSION_OVERFLOW");
});

test("an unreadable installed version blocks the update unless forced", () => {
  const broken = iface(0, "garbage", { version: null, versionRaw: "garbage" });
  assert.equal(
    reasonFor(plan([broken], [], { interface: candidate("interface", "1.1.0") }), "interface board 0"),
    "UNREADABLE_VERSION"
  );
  const forced = plan([broken], [], { interface: candidate("interface", "1.1.0") }, { force: true });
  assert.equal(itemFor(forced, "interface board 0").update, true);
});

test("an unreachable device is reported, not flashed", () => {
  const dead = iface(3, null, { reachable: false, version: null, versionRaw: null, error: "no answer" });
  const result = plan([dead], [], { interface: candidate("interface", "1.1.0") });
  assert.equal(reasonFor(result, "interface board 3"), "UNREACHABLE");
  assert.equal(itemFor(result, "interface board 3").detail, "no answer");
});

// ---------------------------------------------------------------------------
// Physical safety gates
// ---------------------------------------------------------------------------

test("an empty slot is skipped as SLOT_EMPTY before any version logic runs", () => {
  const empty = pack(4, null, { present: false }, { reachable: false, version: null, versionRaw: null });
  const result = plan([], [empty], { powerbank: candidate("powerbank", "1.1.0") });
  assert.equal(reasonFor(result, "powerbank slot 4"), "SLOT_EMPTY");
});

test("a slot that is not retaining its pack is never flashed", () => {
  const result = plan([], [pack(5, "1.0.0", { locked: false })], {
    powerbank: candidate("powerbank", "1.1.0"),
  });
  assert.equal(reasonFor(result, "powerbank slot 5"), "SLOT_UNLOCKED");
});

test("a pack below the battery floor is skipped with the measured level in the detail", () => {
  const result = plan([], [pack(6, "1.0.0", { powerLevel: 12 })], {
    powerbank: candidate("powerbank", "1.1.0"),
  });
  assert.equal(reasonFor(result, "powerbank slot 6"), "BATTERY_TOO_LOW");
  assert.match(itemFor(result, "powerbank slot 6").detail, /12% < required 30%/);
});

test("the battery floor is configurable", () => {
  const result = plan(
    [],
    [pack(6, "1.0.0", { powerLevel: 40 })],
    { powerbank: candidate("powerbank", "1.1.0") },
    { minBatteryPercent: 60 }
  );
  assert.equal(reasonFor(result, "powerbank slot 6"), "BATTERY_TOO_LOW");
  assert.equal(DEFAULT_MIN_BATTERY_PERCENT, 30);
});

test("a pack whose charge could not be read is skipped, never assumed full", () => {
  const result = plan([], [pack(6, "1.0.0", { powerLevel: null })], {
    powerbank: candidate("powerbank", "1.1.0"),
  });
  assert.equal(reasonFor(result, "powerbank slot 6"), "BATTERY_UNKNOWN");
});

test("a pack reporting low voltage is skipped regardless of its reported percentage", () => {
  const result = plan([], [pack(6, "1.0.0", { lowVoltage: true, powerLevel: 95 })], {
    powerbank: candidate("powerbank", "1.1.0"),
  });
  assert.equal(reasonFor(result, "powerbank slot 6"), "LOW_VOLTAGE");
});

test("a charging pack above the floor is still eligible", () => {
  const result = plan([], [pack(6, "1.0.0", { charging: true, powerLevel: 80 })], {
    powerbank: candidate("powerbank", "1.1.0"),
  });
  assert.equal(itemFor(result, "powerbank slot 6").update, true);
});

// ---------------------------------------------------------------------------
// Filters and caps
// ---------------------------------------------------------------------------

test("--targets excludes a whole device class as FILTERED_OUT", () => {
  const result = plan(
    [iface(0, "1.0.0")],
    [pack(1, "1.0.0")],
    { interface: candidate("interface", "1.1.0"), powerbank: candidate("powerbank", "1.1.0") },
    { kinds: ["powerbank"] }
  );
  assert.equal(reasonFor(result, "interface board 0"), "FILTERED_OUT");
  assert.equal(itemFor(result, "powerbank slot 1").update, true);
});

test("--max-targets caps the run and marks the remainder MAX_TARGETS_REACHED", () => {
  const result = plan(
    [],
    [pack(1, "1.0.0"), pack(2, "1.0.0"), pack(3, "1.0.0")],
    { powerbank: candidate("powerbank", "1.1.0") },
    { maxTargets: 2 }
  );
  assert.equal(result.summary.toUpdate, 2);
  assert.equal(reasonFor(result, "powerbank slot 3"), "MAX_TARGETS_REACHED");
});

test("the target cap is spent only on devices that would actually be flashed", () => {
  // Slot 1 is up to date and slot 2 is empty; neither may consume the budget,
  // so slots 3 and 4 still get planned under a cap of 2.
  const result = plan(
    [],
    [
      pack(1, "1.1.0"),
      pack(2, null, { present: false }, { reachable: false, version: null }),
      pack(3, "1.0.0"),
      pack(4, "1.0.0"),
    ],
    { powerbank: candidate("powerbank", "1.1.0") },
    { maxTargets: 2 }
  );
  assert.deepEqual(
    result.items.filter((i) => i.update).map((i) => i.label),
    ["powerbank slot 3", "powerbank slot 4"]
  );
});

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

test("a device that keeps failing the same version is quarantined", () => {
  const state = emptyState();
  const target = { kind: "powerbank", boardAddress: 0, slotIndex: 1 };
  recordFailure(state, target, "1.1.0");
  recordFailure(state, target, "1.1.0");
  recordFailure(state, target, "1.1.0");

  const result = plan([], [pack(1, "1.0.0")], { powerbank: candidate("powerbank", "1.1.0") }, {}, state);
  assert.equal(reasonFor(result, "powerbank slot 1"), "QUARANTINED");
});

test("a quarantine clears as soon as a different version is offered", () => {
  const state = emptyState();
  const target = { kind: "powerbank", boardAddress: 0, slotIndex: 1 };
  for (let i = 0; i < 5; i++) recordFailure(state, target, "1.1.0");

  const result = plan([], [pack(1, "1.0.0")], { powerbank: candidate("powerbank", "1.2.0") }, {}, state);
  assert.equal(itemFor(result, "powerbank slot 1").update, true);
});

test("failures below the threshold do not quarantine", () => {
  const state = emptyState();
  const target = { kind: "powerbank", boardAddress: 0, slotIndex: 1 };
  recordFailure(state, target, "1.1.0");
  recordFailure(state, target, "1.1.0");

  const result = plan([], [pack(1, "1.0.0")], { powerbank: candidate("powerbank", "1.1.0") }, {}, state);
  assert.equal(itemFor(result, "powerbank slot 1").update, true);
});

test("a failure on a new version restarts the counter rather than accumulating", () => {
  const state = emptyState();
  const target = { kind: "powerbank", boardAddress: 0, slotIndex: 1 };
  recordFailure(state, target, "1.1.0");
  recordFailure(state, target, "1.1.0");
  recordFailure(state, target, "1.2.0");
  assert.equal(state.quarantine[targetKey(target)].failures, 1);
});

test("a success wipes the failure history", () => {
  const state = emptyState();
  const target = { kind: "interface", boardAddress: 2, slotIndex: null };
  recordFailure(state, target, "1.1.0");
  recordSuccess(state, target);
  assert.equal(state.quarantine[targetKey(target)], undefined);
});

test("--force overrides a quarantine", () => {
  const state = emptyState();
  const target = { kind: "powerbank", boardAddress: 0, slotIndex: 1 };
  for (let i = 0; i < 5; i++) recordFailure(state, target, "1.1.0");

  const result = plan(
    [],
    [pack(1, "1.0.0")],
    { powerbank: candidate("powerbank", "1.1.0") },
    { force: true },
    state
  );
  assert.equal(itemFor(result, "powerbank slot 1").update, true);
});

// ---------------------------------------------------------------------------
// Summary + option parsing
// ---------------------------------------------------------------------------

test("the summary counts match the items", () => {
  const result = plan(
    [iface(0, "1.0.0"), iface(1, "1.1.0")],
    [pack(1, "1.0.0"), pack(2, "1.0.0", { powerLevel: 5 })],
    { interface: candidate("interface", "1.1.0"), powerbank: candidate("powerbank", "1.1.0") }
  );
  assert.deepEqual(result.summary, {
    total: 4,
    toUpdate: 2,
    skipped: 2,
    interfaceToUpdate: 1,
    powerbankToUpdate: 1,
  });
});

test("parseIndexList expands singles and ranges, and rejects out-of-range values", () => {
  assert.deepEqual(parseIndexList("1,4,7-9", 1, 30, "slot index"), [1, 4, 7, 8, 9]);
  assert.deepEqual(parseIndexList("", 1, 30, "slot index"), []);
  assert.deepEqual(parseIndexList(undefined, 1, 30, "slot index"), []);
  assert.deepEqual(parseIndexList("3-3", 1, 30, "slot index"), [3]);
  assert.throws(() => parseIndexList("0", 1, 30, "slot index"), /outside the valid range/);
  assert.throws(() => parseIndexList("31", 1, 30, "slot index"), /outside the valid range/);
  assert.throws(() => parseIndexList("9-7", 1, 30, "slot index"), /start above end/);
});

test("parseKinds defaults to both classes and accepts the usual aliases", () => {
  assert.deepEqual(parseKinds(undefined), ["interface", "powerbank"]);
  assert.deepEqual(parseKinds("interface"), ["interface"]);
  assert.deepEqual(parseKinds("pb"), ["powerbank"]);
  assert.deepEqual(parseKinds("board,pack"), ["interface", "powerbank"]);
  assert.throws(() => parseKinds("nonsense"), /Unknown target/);
});

test("formatVersion round-trips a parsed version", () => {
  assert.equal(formatVersion(parseVersion("v10.2.30")), "10.2.30");
});

// ---------------------------------------------------------------------------
// F13: recovery of devices stuck in their bootloader
// ---------------------------------------------------------------------------

const stuckBoard = () =>
  iface(0, null, { reachable: false, version: null, versionRaw: null, inBootloader: true, error: "bootloader" });
const stuckPack = (slotOverrides = {}) =>
  pack(3, null, { powerLevel: null, powerbankId: null, ...slotOverrides }, {
    reachable: false,
    version: null,
    versionRaw: null,
    inBootloader: true,
  });

test("a board stuck in its bootloader is planned for recovery, not written off", () => {
  const result = plan([stuckBoard()], [], { interface: candidate("interface", "1.1.0") });
  const it = itemFor(result, "interface board 0");
  assert.equal(it.update, true);
  assert.equal(it.recovery, true);
  assert.match(it.detail, /recovery/);
});

test("a stuck pack is recovered although its charge cannot be read", () => {
  const result = plan([], [stuckPack()], { powerbank: candidate("powerbank", "1.1.0") });
  assert.equal(itemFor(result, "powerbank slot 3").update, true);
});

test("recovery still honours a charge that IS known and too low", () => {
  const result = plan([], [stuckPack({ powerLevel: 5 })], { powerbank: candidate("powerbank", "1.1.0") });
  assert.equal(reasonFor(result, "powerbank slot 3"), "BATTERY_TOO_LOW");
});

test("recovery still refuses a pack that is not retained", () => {
  const result = plan([], [stuckPack({ locked: false })], { powerbank: candidate("powerbank", "1.1.0") });
  assert.equal(reasonFor(result, "powerbank slot 3"), "SLOT_UNLOCKED");
});

test("recovery needs a release like any other flash", () => {
  const result = plan([stuckBoard()], [], { interface: null });
  assert.equal(reasonFor(result, "interface board 0"), "NO_RELEASE");
});

test("a device that keeps failing recovery is quarantined", () => {
  const state = emptyState();
  const target = { kind: "interface", boardAddress: 0, slotIndex: null };
  for (let i = 0; i < 3; i++) recordFailure(state, target, "1.1.0");
  const result = plan([stuckBoard()], [], { interface: candidate("interface", "1.1.0") }, {}, state);
  assert.equal(reasonFor(result, "interface board 0"), "QUARANTINED");
});

test("an unreachable device with no bootloader is still UNREACHABLE", () => {
  const dead = iface(0, null, { reachable: false, version: null, versionRaw: null, error: "no answer" });
  const result = plan([dead], [], { interface: candidate("interface", "1.1.0") });
  assert.equal(reasonFor(result, "interface board 0"), "UNREACHABLE");
});
