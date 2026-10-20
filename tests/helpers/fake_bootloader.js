/**
 * An in-memory stand-in for a station board or a powerbank, speaking the
 * firmware-update (FWU) wire protocol well enough to drive the real
 * orchestrators end to end with no hardware attached.
 *
 * It implements the only method the command classes call —
 * `sendMessage({ boardAddress, command, data }) → Buffer` — and answers in the
 * same `[board][opcode][status][payload…]` shape the real transport returns,
 * so `BaseCommand` parses it exactly as it would a live frame.
 *
 * Every request is recorded in `transcript`. That transcript is what the golden
 * tests freeze: it is the complete, byte-exact description of what the host put
 * on the wire, so a refactor that changes nothing must reproduce it exactly.
 *
 * Faults are injected by option, each modelling a failure seen on real links:
 *   offsetMismatchAt  the Nth DATA reports the previous chunk as lost
 *   failDataAt        the Nth DATA is rejected outright
 *   bogusOffsetAt     the Nth DATA reports next_expected_offset = 0xFFFFFFFF
 *   corruptCrc        END rejects the image (CRC mismatch)
 *   enterFails        the application refuses to reset into the bootloader
 *   noHello           the bootloader does not answer HELLO
 *   shortHello        HELLO answers with a truncated payload
 *   exitFails         the bootloader does not acknowledge EXIT
 *   slotSize          advertise a smaller application slot than the image
 *   startInBootloader the device is already stuck in its bootloader
 *   powerLossAt       the Nth DATA never answers (the transport throws, as
 *                     SerialService does on a 5 s timeout) and the device
 *                     comes back up in its bootloader with no valid app
 *   noValidApp        the application header is invalid (an earlier flash was
 *                     interrupted), so the device cannot leave its bootloader
 *                     until a new image is written
 *
 * Link faults on DATA, counted over every DATA frame that reaches the fake
 * (`dataFrames`, 1-based), each a list of frame numbers:
 *   lostRequestAt     the frame is lost on its way: nothing is written and the
 *                     transport throws (SerialService's 5 s timeout)
 *   lostReplyAt       the chunk IS written, but its reply is lost: the
 *                     transport throws, and a re-send of the same offset is
 *                     answered OFFSET_MISMATCH (what both bootloaders do)
 *   linkTimeoutAt     the board's own pogo retries got no answer from the
 *                     pack: status 0x01, with stack garbage where
 *                     next_expected_offset goes (S1TTXX host_protocol.c)
 *   silentFromData    from this frame on, the device never answers again
 */

const STATUS_OK = 0x00;
const STATUS_ERR_INVALID_CMD = 0x02;
const STATUS_ERR_INVALID_ARGS = 0x03;
const STATUS_ERR_INTERNAL = 0x04;
const STATUS_LINK_TIMEOUT = 0x01;
const STATUS_OFFSET_MISMATCH = 0x10;
const STATUS_NO_SESSION = 0x13;

/** Opcode base per device class; the step order is identical for both. */
const OPCODE_BASE = { station: 0x60, powerbank: 0x10 };
const STEP = { ENTER: 0, HELLO: 1, BEGIN: 2, DATA: 3, END: 4, ABORT: 5, EXIT: 6 };

function crc32(buf) {
  let crc = 0xffffffff >>> 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc ^ buf[i]) >>> 0;
    for (let b = 0; b < 8; b++) {
      const mask = -(crc & 1) >>> 0;
      crc = ((crc >>> 1) ^ (0xedb88320 & mask)) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class FakeBootloaderDevice {
  constructor(opts = {}) {
    this.kind = opts.kind ?? "station";
    this.boardAddress = opts.boardAddress ?? 0;
    this.slotInBoard = opts.slotInBoard ?? 0;
    this.slotSize = opts.slotSize ?? 51200;
    this.pageSize = opts.pageSize ?? 1024;
    this.maxChunk = opts.maxChunk ?? 32;
    this.faults = opts.faults ?? {};

    this.mode = this.faults.startInBootloader || this.faults.noValidApp ? "bl" : "app";
    // Whether the application header is valid. A real bootloader boots the
    // application after EXIT only if it is; otherwise it stays put.
    this.appValid = !this.faults.noValidApp;
    this.session = null;
    this.dataCalls = 0;
    this.dataFrames = 0;
    this.headerVersion = null;
    this.transcript = [];
  }

  /** Same contract as SerialService.sendMessage. */
  async sendMessage(message) {
    const data = message.data ?? Buffer.alloc(0);
    this.transcript.push({
      board: message.boardAddress,
      cmd: `0x${message.command.toString(16).padStart(2, "0")}`,
      data: data.toString("hex"),
    });

    if (this.silent) throw new Error("Request timeout - no response received");

    const base = OPCODE_BASE[this.kind];
    const step = message.command - base;
    const reply = (status, payload = Buffer.alloc(0)) =>
      Buffer.concat([Buffer.from([message.boardAddress, message.command, status]), payload]);

    if (step < 0 || step > STEP.EXIT) return reply(STATUS_ERR_INVALID_CMD);

    // A powerbank frame carries its slot as the first byte; strip and check it.
    let body = data;
    if (this.kind === "powerbank") {
      if (data.length < 1 || data[0] !== this.slotInBoard) return reply(STATUS_ERR_INVALID_ARGS);
      body = data.subarray(1);
    }

    switch (step) {
      case STEP.EXIT:
        if (this.mode !== "bl" || this.faults.exitFails) return reply(STATUS_ERR_INVALID_CMD);
        // Acknowledged either way; after the reset the bootloader only hands
        // over to an application whose header is valid.
        this.mode = this.appValid ? "app" : "bl";
        this.session = null;
        return reply(STATUS_OK);

      case STEP.ENTER:
        if (this.mode !== "app" || this.faults.enterFails) return reply(STATUS_ERR_INVALID_CMD);
        this.mode = "bl";
        return reply(STATUS_OK);

      case STEP.HELLO: {
        if (this.mode !== "bl" || this.faults.noHello) return reply(STATUS_ERR_INTERNAL);
        if (this.faults.shortHello) return reply(STATUS_OK, Buffer.from([0, 1, 1]));
        const p = Buffer.alloc(15);
        p.writeUInt8(0, 0); // BL major
        p.writeUInt8(1, 1); // BL minor
        p.writeUInt8(this.headerVersion === null ? 0 : 1, 2);
        p.writeUInt32LE(this.headerVersion ?? 0, 3);
        p.writeUInt16LE(this.maxChunk, 7);
        p.writeUInt16LE(this.pageSize, 9);
        p.writeUInt32LE(this.slotSize, 11);
        return reply(STATUS_OK, p);
      }

      case STEP.BEGIN: {
        if (this.mode !== "bl" || body.length < 12) return reply(STATUS_ERR_INVALID_ARGS);
        const size = body.readUInt32LE(0);
        if (size === 0 || size > this.slotSize) return reply(STATUS_ERR_INVALID_ARGS);
        this.session = {
          size,
          crc: body.readUInt32LE(4),
          version: body.readUInt32LE(8),
          image: Buffer.alloc(size),
          next: 0,
          lastChunk: 0,
        };
        // Real bootloaders erase the header on BEGIN: until END succeeds the
        // device has no valid application.
        this.headerVersion = null;
        this.appValid = false;
        return reply(STATUS_OK);
      }

      case STEP.DATA: {
        this.dataFrames++;
        const at = (list) => Array.isArray(list) && list.includes(this.dataFrames);
        if (this.faults.silentFromData && this.dataFrames >= this.faults.silentFromData) {
          this.silent = true;
        }
        if (this.silent || at(this.faults.lostRequestAt)) {
          throw new Error("Request timeout - no response received");
        }
        if (at(this.faults.linkTimeoutAt)) {
          return reply(STATUS_LINK_TIMEOUT, Buffer.from([0xef, 0xbe, 0xad, 0xde]));
        }
        if (this.faults.powerLossAt && this.dataCalls + 1 === this.faults.powerLossAt) {
          this.dataCalls++;
          delete this.faults.powerLossAt; // one-shot: the next power-up is healthy
          this.session = null;
          this.mode = "bl";
          this.appValid = false;
          throw new Error("Request timeout - no response received");
        }
        const s = this.session;
        // A bootloader with no open session (it reset since BEGIN) says so.
        if (this.mode === "bl" && !s) return reply(STATUS_NO_SESSION, Buffer.alloc(4));
        if (this.mode !== "bl" || !s || body.length < 5) return reply(STATUS_ERR_INVALID_ARGS);
        this.dataCalls++;
        const offset = body.readUInt32LE(0);
        const len = body.readUInt8(4);
        const bytes = body.subarray(5, 5 + len);
        const offsetReply = (status, next) => {
          const p = Buffer.alloc(4);
          p.writeUInt32LE(next >>> 0, 0);
          return reply(status, p);
        };

        if (this.faults.failDataAt === this.dataCalls) return reply(STATUS_ERR_INTERNAL);
        if (this.faults.bogusOffsetAt === this.dataCalls) return offsetReply(STATUS_OK, 0xffffffff);
        if (this.faults.offsetMismatchAt === this.dataCalls && s.next > 0) {
          // Model a lost chunk: the previous write never landed.
          s.next -= s.lastChunk;
          return offsetReply(STATUS_OFFSET_MISMATCH, s.next);
        }
        if (offset !== s.next) return offsetReply(STATUS_OFFSET_MISMATCH, s.next);

        bytes.copy(s.image, offset);
        s.next += len;
        s.lastChunk = len;
        if (at(this.faults.lostReplyAt)) throw new Error("Request timeout - no response received");
        return offsetReply(STATUS_OK, s.next);
      }

      case STEP.END: {
        const s = this.session;
        if (this.mode !== "bl" || !s) return reply(STATUS_ERR_INVALID_ARGS);
        if (s.next !== s.size || this.faults.corruptCrc || crc32(s.image) !== s.crc) {
          return reply(STATUS_ERR_INTERNAL);
        }
        this.headerVersion = s.version;
        this.appValid = true;
        this.session = null;
        return reply(STATUS_OK);
      }

      case STEP.ABORT:
        this.session = null;
        return reply(STATUS_OK);
    }
    return reply(STATUS_ERR_INVALID_CMD);
  }
}

module.exports = { FakeBootloaderDevice, crc32 };
