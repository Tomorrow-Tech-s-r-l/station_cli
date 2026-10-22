// Unit tests for the passive serial trace sink (marker file -> serial-trace.jsonl).
// Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const trace = require("../../dist/utils/serial_trace");
const { TransportProtocol } = require("../../dist/S1TTXX/services/transport");

function setup({ marker = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial-trace-"));
  const markerPath = path.join(dir, "serial-trace.on");
  const file = path.join(dir, "logs", "serial-trace.jsonl");
  if (marker) fs.writeFileSync(markerPath, "");
  process.env.STATION_CLI_SERIAL_TRACE_MARKER = markerPath;
  process.env.STATION_CLI_SERIAL_TRACE_FILE = file;
  trace.resetSerialTraceForTests();
  return { dir, markerPath, file };
}

const records = (file) =>
  fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Run a synchronous fn while collecting every write to stdout and stderr. */
function captureStdio(fn) {
  const written = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk) => (written.push(["stdout", String(chunk)]), true);
  process.stderr.write = (chunk) => (written.push(["stderr", String(chunk)]), true);
  try {
    fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return written;
}

test("defaults point at the kiosk's state and log directories", () => {
  assert.equal(trace.DEFAULT_SERIAL_TRACE_MARKER, "/var/lib/amperry-kiosk-local/serial-trace.on");
  assert.equal(trace.DEFAULT_SERIAL_TRACE_FILE, "/var/lib/amperry-kiosk-local/logs/serial-trace.jsonl");
});

test("without the marker nothing is written", () => {
  const { file } = setup({ marker: false });
  trace.serialTrace("tx", "/dev/ttyUSB0", Buffer.from([0xea, 0x00, 0x05]));
  assert.equal(trace.isSerialTraceOn(), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.dirname(file)), false);
});

test("with the marker each frame is one JSON line", () => {
  const { file } = setup();
  trace.serialTrace("tx", "/dev/ttyUSB0", Buffer.from([0xea, 0x00, 0x05, 0x12, 0x34]), "board=0 cmd=0x05");
  trace.serialTrace("rx", "/dev/ttyUSB0", Buffer.from([0xea, 0x00, 0x05, 0x00]));
  const [tx, rx] = records(file);
  assert.deepEqual(Object.keys(tx).sort(), ["dir", "hex", "note", "port", "ts"]);
  assert.equal(tx.dir, "tx");
  assert.equal(tx.port, "/dev/ttyUSB0");
  assert.equal(tx.hex, "ea00051234");
  assert.equal(tx.note, "board=0 cmd=0x05");
  assert.match(tx.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(rx.dir, "rx");
  assert.equal(rx.hex, "ea000500");
  assert.equal("note" in rx, false);
});

test("the marker is checked once per process", () => {
  const { file, markerPath } = setup();
  trace.serialTrace("tx", "p", Buffer.from([1]));
  fs.rmSync(markerPath);
  trace.serialTrace("tx", "p", Buffer.from([2]));
  assert.equal(records(file).length, 2, "still on after the marker went away");

  trace.resetSerialTraceForTests();
  trace.serialTrace("tx", "p", Buffer.from([3]));
  assert.equal(records(file).length, 2, "a new process (reset) sees it off");
});

test("an unwritable trace file never throws and never prints", () => {
  const { dir } = setup();
  const blocker = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocker, "");
  process.env.STATION_CLI_SERIAL_TRACE_FILE = path.join(blocker, "serial-trace.jsonl");
  trace.resetSerialTraceForTests();
  const written = captureStdio(() => {
    assert.doesNotThrow(() => trace.serialTrace("tx", "p", Buffer.from([1, 2, 3])));
  });
  assert.deepEqual(written, []);
});

test("the trace rotates at 5 MB like station-cli.jsonl", () => {
  const { file } = setup();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(5 * 1024 * 1024, 0x61));
  fs.writeFileSync(`${file}.1`, "older\n");
  trace.serialTrace("rx", "p", Buffer.from([0xab]));
  assert.equal(fs.statSync(`${file}.1`).size, 5 * 1024 * 1024);
  assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "older\n");
  assert.equal(records(file).length, 1);
  assert.equal(records(file)[0].hex, "ab");
});

// One real SerialService.sendMessage() in a fresh process, as a kiosk spawn
// would run it: no --raw, `serialport` swapped for an in-memory port so
// connect() still runs for real (open, inter-byte parser, flush) and every
// frame written is answered with REPLY. Its stdout/stderr must stay empty.
const CHILD = `
const { Readable } = require("node:stream");
const reply = Buffer.from(process.env.REPLY, "hex");
class FakePort extends Readable {
  constructor(opts) { super(); FakePort.last = this; this.sent = []; }
  _read() {}
  open(cb) { cb(null); }
  flush(cb) { if (cb) cb(null); }
  write(frame, cb) { this.sent.push(Buffer.from(frame)); cb(null); setImmediate(() => this.push(reply)); return true; }
  close(cb) { this.push(null); cb(); }
}
const id = require.resolve("serialport");
require.cache[id] = { id, filename: id, loaded: true, exports: { SerialPort: FakePort } };
const { SerialService } = require(process.env.DIST + "/S1TTXX/services/serial");
(async () => {
  const service = new SerialService("/dev/ttyUSB0");
  await service.connect();
  const response = await service.sendMessage({ boardAddress: 0, command: 0x05 });
  await service.disconnect();
  require("node:fs").writeFileSync(process.env.RESULT, JSON.stringify({
    response: response.toString("hex"),
    sent: FakePort.last.sent.map((b) => b.toString("hex")),
  }));
})().catch((e) => { require("node:fs").writeFileSync(process.env.RESULT, JSON.stringify({ error: String(e) })); });
`;

function runSerialService(env, reply) {
  const result = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "serial-trace-run-")), "result.json");
  const child = spawnSync(process.execPath, ["-e", CHILD], {
    cwd: path.join(__dirname, "..", ".."),
    env: {
      ...process.env,
      ...env,
      DEBUG: "",
      DIST: path.join(__dirname, "..", "..", "dist"),
      REPLY: reply.toString("hex"),
      RESULT: result,
    },
    encoding: "utf8",
  });
  return { child, result: JSON.parse(fs.readFileSync(result, "utf8")) };
}

test("SerialService traces both TX and RX without --raw, silently", () => {
  const { file, markerPath } = setup();
  // Reply body: board 0, cmd 0x05 (SLOTS), status 0, one data byte.
  const reply = TransportProtocol.buildFrame(Buffer.from([0x00, 0x05, 0x00, 0x3f]));
  const { child, result } = runSerialService(
    { STATION_CLI_SERIAL_TRACE_MARKER: markerPath, STATION_CLI_SERIAL_TRACE_FILE: file },
    reply
  );
  assert.equal(result.error, undefined);
  assert.equal(child.stdout, "", "nothing on stdout");
  assert.equal(child.stderr, "", "nothing on stderr");
  assert.equal(result.response, "0005003f");

  const recs = records(file);
  assert.equal(recs.length, 2);
  const [tx, rx] = recs;
  assert.equal(tx.dir, "tx");
  assert.equal(tx.port, "/dev/ttyUSB0");
  assert.equal(tx.hex, result.sent[0]);
  assert.equal(tx.note, "board=0 cmd=0x05");
  assert.equal(rx.dir, "rx");
  assert.equal(rx.port, "/dev/ttyUSB0");
  assert.equal(rx.hex, reply.toString("hex"));
  assert.match(rx.note, /^\d+ms after tx$/);
});

test("SerialService writes no trace when the marker is absent", () => {
  const { file, markerPath } = setup({ marker: false });
  const reply = TransportProtocol.buildFrame(Buffer.from([0x00, 0x05, 0x00]));
  const { child, result } = runSerialService(
    { STATION_CLI_SERIAL_TRACE_MARKER: markerPath, STATION_CLI_SERIAL_TRACE_FILE: file },
    reply
  );
  assert.equal(result.error, undefined);
  assert.equal(child.stdout + child.stderr, "");
  assert.equal(fs.existsSync(file), false);
});
