/**
 * A whole station in memory: interface boards, their six slots, and the packs
 * docked in them — enough to run the firmware engine end to end.
 *
 * Firmware-update opcodes are delegated to a FakeBootloaderDevice per board
 * and per docked pack, so a flash goes through the real protocol. On top of
 * that it answers the application-side queries the engine uses to plan:
 * CMD_GET_FW_VER (board version), SLOTS (occupancy/retention), STATUS (charge,
 * serial) and PB_FW_VER (pack version).
 *
 * A device that has accepted a new image reports the version stamped in its
 * header, exactly as real firmware does after reset; a device left in its
 * bootloader by a failed flash stops answering application queries — which is
 * what makes the engine's read-back verification meaningful here.
 *
 * `hooks.beforeSlots(board, n)` runs before the n-th SLOTS answer for a board,
 * so a test can change the cabinet between planning and flashing.
 */

const { FakeBootloaderDevice } = require("./fake_bootloader");

const CMD_STATUS = 0x01;
const CMD_SLOTS = 0x05;
const CMD_PB_FW_VER = 0x0a;
const CMD_GET_FW_VER = 0x50;
const STATUS_OK = 0x00;
const STATUS_ERR_INTERNAL = 0x04;

const unpack = (w) => `${(w >>> 16) & 0xff}.${(w >>> 8) & 0xff}.${w & 0xff}`;

class FakeStation {
  /**
   * @param {object} spec  { boards: { [addr]: { version, dead?, faults?, slots: [pack|null ×6] } } }
   *   pack = { id, version, level, locked?=true, faults?, reportsVersion? }
   */
  constructor(spec, hooks = {}) {
    this.hooks = hooks;
    this.boards = new Map();
    this.slotsCalls = new Map();
    this.log = [];
    for (const [addr, b] of Object.entries(spec.boards)) {
      const boardAddress = Number(addr);
      this.boards.set(boardAddress, {
        version: b.version,
        dead: b.dead === true,
        device: new FakeBootloaderDevice({ kind: "station", boardAddress, faults: b.faults ?? {} }),
        slots: (b.slots ?? []).map((p, slotInBoard) => this.#makePack(boardAddress, slotInBoard, p)),
      });
    }
  }

  #makePack(boardAddress, slotInBoard, p) {
    if (!p) return null;
    return {
      ...p,
      locked: p.locked !== false,
      device: new FakeBootloaderDevice({
        kind: "powerbank",
        boardAddress,
        slotInBoard,
        faults: p.faults ?? {},
      }),
    };
  }

  /** Replace what is docked in a slot (null empties it). */
  dock(boardAddress, slotInBoard, pack) {
    this.boards.get(boardAddress).slots[slotInBoard] = this.#makePack(boardAddress, slotInBoard, pack);
  }

  /** The version a device's application reports, or null if it cannot run. */
  #appVersion(entity) {
    const dev = entity.device;
    if (dev.mode === "bl") return null;
    if (entity.reportsVersion) return entity.reportsVersion;
    return dev.headerVersion !== null ? unpack(dev.headerVersion) : entity.version;
  }

  async sendMessage(message) {
    const { boardAddress, command } = message;
    const data = message.data ?? Buffer.alloc(0);
    this.log.push({ board: boardAddress, cmd: command, data: data.toString("hex") });
    const reply = (status, payload = Buffer.alloc(0)) =>
      Buffer.concat([Buffer.from([boardAddress, command, status]), payload]);

    const board = this.boards.get(boardAddress);
    if (!board || board.dead) return reply(STATUS_ERR_INTERNAL);

    // Station FWU opcodes are answered by the board's own bootloader.
    if (command >= 0x60 && command <= 0x66) return board.device.sendMessage(message);

    // Everything else — including relaying to a pack — needs the board's
    // application running. A board stuck in its bootloader relays nothing.
    if (board.device.mode === "bl") return reply(STATUS_ERR_INTERNAL);

    if (command >= 0x10 && command <= 0x16) {
      const pack = board.slots[data[0]];
      if (!pack) return reply(STATUS_ERR_INTERNAL);
      return pack.device.sendMessage(message);
    }

    switch (command) {
      case CMD_GET_FW_VER: {
        const v = this.#appVersion(board);
        return v ? reply(STATUS_OK, Buffer.from(v, "utf8")) : reply(STATUS_ERR_INTERNAL);
      }
      case CMD_SLOTS: {
        const n = (this.slotsCalls.get(boardAddress) ?? 0) + 1;
        this.slotsCalls.set(boardAddress, n);
        this.hooks.beforeSlots?.(boardAddress, n, this);
        let fill = 0;
        let lock = 0;
        board.slots.forEach((p, i) => {
          if (!p) return;
          fill |= 1 << i;
          // SLOT_LOCKED is 0: the bit is CLEAR while the pack is retained.
          if (!p.locked) lock |= 1 << i;
        });
        // Empty slots report "unlocked".
        for (let i = 0; i < 6; i++) if (!board.slots[i]) lock |= 1 << i;
        return reply(STATUS_OK, Buffer.from([fill, lock]));
      }
      case CMD_STATUS: {
        const pack = board.slots[data[0]];
        if (!pack || pack.device.mode === "bl") return reply(STATUS_ERR_INTERNAL);
        const p = Buffer.alloc(25);
        p.write((pack.id ?? "").padEnd(10, "\0").slice(0, 10), 0, "utf8");
        p.writeUInt32LE(0, 10);
        p.writeUInt16LE(1000, 14); // totalCharge
        p.writeUInt16LE(Math.round((pack.level ?? 0) * 10), 16); // currentCharge → level%
        p.writeUInt16LE(0, 18); // cutoffCharge
        p.writeUInt16LE(0, 20); // cycles
        p.writeUInt8(1, 22); // status: idle
        p.writeUInt16LE(0, 23); // avgCapacity
        return reply(STATUS_OK, p);
      }
      case CMD_PB_FW_VER: {
        const pack = board.slots[data[0]];
        if (!pack) return reply(STATUS_ERR_INTERNAL);
        const v = this.#appVersion(pack);
        if (!v) return reply(STATUS_ERR_INTERNAL);
        const p = Buffer.alloc(29);
        p.write("P1TT2C-firmware", 0, "utf8");
        p.write(v, 16, "utf8");
        return reply(STATUS_OK, p);
      }
    }
    return reply(0x02);
  }

  /** Count of FWU frames sent to one device class, for "was it touched?" asserts. */
  fwuFramesTo(boardAddress, slotInBoard = null) {
    return this.log.filter((e) => {
      if (e.board !== boardAddress) return false;
      if (slotInBoard === null) return e.cmd >= 0x60 && e.cmd <= 0x66;
      return e.cmd >= 0x10 && e.cmd <= 0x16 && parseInt(e.data.slice(0, 2), 16) === slotInBoard;
    }).length;
  }
}

module.exports = { FakeStation };
