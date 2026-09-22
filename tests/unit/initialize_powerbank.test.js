// Unit tests for `initialize-powerbank`, driven through a stub serial service
// so the write ordering and the refusal paths can be checked without a board.
// Run with `npm test` (builds to dist/ first, then node --test).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  InitializePowerbankCommand,
  NothingWrittenError,
} = require("../../dist/S1TTXX/cli/commands/initialize_powerbank");
const {
  CMD_STATUS_CODE,
  CMD_SET_INFO_PWB,
  CMD_SET_INFO_BATTERY,
  STATUS_ERR_INVALID_ARGS,
} = require("../../dist/utils/constants");
const {
  DEFAULT_TOTAL_CHARGE_MAH,
  DEFAULT_CURRENT_CHARGE_MAH,
  DEFAULT_CUTOFF_CHARGE_MAH,
} = require("../../dist/S1TTXX/utils/battery_info");

const SOUND_PARAMS = {
  serialNumber: "KNOWNGOOD4",
  timestamp: 1_700_000_000,
  cycles: 0,
  totalCharge: DEFAULT_TOTAL_CHARGE_MAH,
  currentCharge: DEFAULT_CURRENT_CHARGE_MAH,
  cutoffCharge: DEFAULT_CUTOFF_CHARGE_MAH,
};

/** A CMD_STATUS payload, laid out as StatusCommand parses it. */
function statusPayload(pack) {
  const payload = Buffer.alloc(25);
  payload.write(pack.serial, 0, 10, "utf8");
  payload.writeUInt32LE(pack.timestamp, 10);
  payload.writeUInt16LE(pack.totalCharge, 14);
  payload.writeUInt16LE(pack.currentCharge, 16);
  payload.writeUInt16LE(pack.cutoffCharge, 18);
  payload.writeUInt16LE(pack.cycles, 20);
  payload.writeUInt8(pack.status, 22);
  payload.writeUInt16LE(pack.avgCapacity, 23);
  return payload;
}

/**
 * Stands in for SerialService. Records the opcodes it is handed, in order, and
 * answers each with the status the test asked for. Frame layout is what
 * BaseCommand expects: [boardAddress, command, status, ...payload].
 */
function stubService({ batteryStatus = 0, infoStatus = 0, pack = null } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(message) {
      sent.push(message.command);
      switch (message.command) {
        case CMD_SET_INFO_BATTERY:
          return Buffer.from([0, CMD_SET_INFO_BATTERY, batteryStatus]);
        case CMD_SET_INFO_PWB:
          return Buffer.from([0, CMD_SET_INFO_PWB, infoStatus]);
        case CMD_STATUS_CODE:
          return Buffer.concat([
            Buffer.from([0, CMD_STATUS_CODE, 0]),
            statusPayload(pack),
          ]);
        default:
          throw new Error(`unexpected opcode 0x${message.command.toString(16)}`);
      }
    },
  };
}

const FULL_PACK = {
  serial: "KNOWNGOOD4",
  timestamp: 1_700_000_000,
  totalCharge: DEFAULT_TOTAL_CHARGE_MAH,
  currentCharge: DEFAULT_CURRENT_CHARGE_MAH,
  cutoffCharge: DEFAULT_CUTOFF_CHARGE_MAH,
  cycles: 0,
  status: 2,
  avgCapacity: 3500,
};

test("an incoherent nameplate is refused with nothing sent", async () => {
  // cutoff above total: written with success:true to a fw 3.0.2 pack on the
  // bench, and refused by a 3.1.0 pack only *after* the serial had committed.
  const service = stubService();
  const command = new InitializePowerbankCommand(service);

  await assert.rejects(
    () =>
      command.execute(0, 3, {
        ...SOUND_PARAMS,
        serialNumber: "ZZZZZZZZZ9",
        totalCharge: 10000,
        currentCharge: 9000,
        cutoffCharge: 10625,
      }),
    NothingWrittenError
  );
  assert.deepEqual(service.sent, []);
});

test("--total-charge 0 is refused, not silently replaced by the default", async () => {
  // It used to be swapped for the default one layer down (0 is falsy) while
  // the response echoed the 0 the caller had asked for.
  const service = stubService();
  const command = new InitializePowerbankCommand(service);

  await assert.rejects(
    () => command.execute(0, 3, { ...SOUND_PARAMS, totalCharge: 0 }),
    NothingWrittenError
  );
  assert.deepEqual(service.sent, []);
});

test("the nameplate is written before the identity", async () => {
  const service = stubService({ pack: FULL_PACK });
  const command = new InitializePowerbankCommand(service);

  const response = await command.execute(0, 3, SOUND_PARAMS);

  assert.equal(response.success, true);
  assert.deepEqual(service.sent, [
    CMD_SET_INFO_BATTERY,
    CMD_SET_INFO_PWB,
    CMD_STATUS_CODE,
  ]);
});

test("a pack that refuses the nameplate keeps its serial", async () => {
  const service = stubService({ batteryStatus: STATUS_ERR_INVALID_ARGS });
  const command = new InitializePowerbankCommand(service);

  const response = await command.execute(0, 3, SOUND_PARAMS);
  const outcome = JSON.parse(response.data.toString());

  assert.equal(response.success, false);
  // The identity write is never attempted, so the pack is still tracked under
  // the serial it had.
  assert.deepEqual(service.sent, [CMD_SET_INFO_BATTERY]);
  assert.equal(outcome.stage, "battery-info");
  assert.equal(outcome.batteryInfoWritten, false);
  assert.equal(outcome.powerbankInfoWritten, false);
});

test("the values reported are the pack's own, read back after the write", async () => {
  // The gauge does not land exactly where it was told to; the response has to
  // say what the pack holds rather than repeat the request back.
  const settled = { ...FULL_PACK, currentCharge: DEFAULT_CURRENT_CHARGE_MAH - 1 };
  const service = stubService({ pack: settled });
  const command = new InitializePowerbankCommand(service);

  const response = await command.execute(0, 3, SOUND_PARAMS);
  const outcome = JSON.parse(response.data.toString());

  assert.equal(outcome.stage, "complete");
  assert.equal(outcome.verificationError, null);
  assert.equal(outcome.written.currentCharge, DEFAULT_CURRENT_CHARGE_MAH);
  assert.equal(outcome.verified.currentCharge, DEFAULT_CURRENT_CHARGE_MAH - 1);
  assert.equal(outcome.verified.serial, "KNOWNGOOD4");
});

test("a short serial is refused with nothing sent", async () => {
  const service = stubService();
  const command = new InitializePowerbankCommand(service);

  await assert.rejects(
    () => command.execute(0, 3, { ...SOUND_PARAMS, serialNumber: "TOOSHORT" }),
    NothingWrittenError
  );
  assert.deepEqual(service.sent, []);
});
