#!/usr/bin/env python3
"""End-to-end test: powerbanks with impossible charge parameters.

Runs the real CLI against an emulated S1TT6 station over a PTY, so every layer
below the command classes — serialport, framing, CRC16, retries — executes for
real. The station serves powerbanks whose stored charge parameters are wrong in
the three ways that matter, and the test asserts that `slots` resets them and
puts them back in the charging rotation.

    npm run build && python3 tests/battery_reset_emulator_test.py

Pass `--baseline <dir>` pointing at a built checkout of an older commit to also
print the before/after comparison.
"""
import json
import os
import pty
import select
import struct
import subprocess
import sys
import time
import tty

SOF = 0xEA
CMD_STATUS, CMD_SET_CHARGE, CMD_SLOTS, CMD_SET_INFO_BATTERY = 0x01, 0x02, 0x05, 0x09
# Total frame length per opcode: SOF + addr + opcode + args + CRC16.
FRAME_LEN = {CMD_STATUS: 6, CMD_SET_CHARGE: 7, CMD_SLOTS: 5, CMD_SET_INFO_BATTERY: 12}

PB_IDLE, PB_PLUGGED_IN = 1, 2
DEFAULTS = (13925, 11625, 10625)


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def frame(payload: bytes) -> bytes:
    return bytes([SOF]) + payload + struct.pack("<H", crc16_modbus(payload))


class Pack:
    def __init__(self, serial, total, current, cutoff, status, cycles=12, vmv=16800):
        self.serial, self.total, self.current = serial, total, current
        self.cutoff, self.status, self.cycles, self.vmv = cutoff, status, cycles, vmv

    def status_payload(self) -> bytes:
        """CMD_STATUS response body, as S1TTXX/cli/commands/status.ts parses it."""
        out = bytearray(25)
        out[0:10] = self.serial.encode()[:10].ljust(10, b"\0")
        struct.pack_into("<I", out, 10, 1740000000)
        struct.pack_into("<HHHH", out, 14, self.total, self.current, self.cutoff, self.cycles)
        out[22] = self.status
        struct.pack_into("<H", out, 23, self.vmv)
        return bytes(out)


class Station:
    """One emulated board.

    latch_status:  the pack keeps reporting IDLE even after its parameters are
                   corrected (models firmware that does not re-evaluate).
    refuse_writes: the pack NACKs CMD_SET_INFO_BATTERY.
    fail_reread:   the pack stops answering CMD_STATUS once it has been written.
    """

    def __init__(self, packs, latch_status=False, refuse_writes=False, fail_reread=False):
        self.packs = packs                  # slot (0-5) -> Pack or None
        self.latch_status = latch_status
        self.refuse_writes = refuse_writes
        self.fail_reread = fail_reread
        self.battery_writes = []            # (slot, total, current, cutoff)
        self.charge_cmds = []               # (slot, enabled)
        self.written_slots = set()

    def handle(self, payload: bytes):
        addr, op, args = payload[0], payload[1], payload[2:]

        if op == CMD_SLOTS:
            fill = lock = 0
            for slot in range(6):
                if self.packs.get(slot) is not None:
                    fill |= 1 << slot          # present
                else:
                    lock |= 1 << slot          # empty slots read as locked
            return bytes([addr, op, 0, fill, lock])

        if op == CMD_STATUS:
            pack = self.packs.get(args[0])
            if pack is None:
                return bytes([addr, op, 1])    # STATUS_TIMEOUT
            if self.fail_reread and args[0] in self.written_slots:
                return bytes([addr, op, 1])    # link timeout on the re-read
            return bytes([addr, op, 0]) + pack.status_payload()

        if op == CMD_SET_INFO_BATTERY:
            slot = args[0]
            total, current, cutoff = struct.unpack_from("<HHH", args, 1)
            self.battery_writes.append((slot, total, current, cutoff))
            if self.refuse_writes:
                return bytes([addr, op, 3])    # ERR_INVALID_ARGS
            self.written_slots.add(slot)
            pack = self.packs.get(slot)
            if pack is not None:
                pack.total, pack.current, pack.cutoff = total, current, cutoff
                if not self.latch_status:
                    # Firmware re-evaluates: no longer full, just a docked pack.
                    pack.status = PB_IDLE if current >= total else PB_PLUGGED_IN
            return bytes([addr, op, 0])

        if op == CMD_SET_CHARGE:
            self.charge_cmds.append((args[0], args[1] == 1))
            return bytes([addr, op, 0])

        return bytes([addr, op, 2])            # ERR_INVALID_CMD


def run(station: Station, cli_args, cwd, timeout=120):
    """Run the CLI against this station over a PTY; return (rc, stdout, stderr)."""
    master, slave = pty.openpty()
    tty.setraw(master)
    tty.setraw(slave)

    proc = subprocess.Popen(
        ["node", "dist/cli.js"] + cli_args, cwd=cwd,
        env=dict(os.environ, STATION_CLI_PORT=os.ttyname(slave)),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    # The slave fd stays open: on Linux the master read()s EIO once the last
    # slave descriptor closes, which would end this loop before the CLI has
    # opened the port by name.
    buf = bytearray()
    deadline = time.time() + timeout
    while proc.poll() is None and time.time() < deadline:
        if not select.select([master], [], [], 0.2)[0]:
            continue
        try:
            buf += os.read(master, 4096)
        except OSError:
            break

        while len(buf) >= 3:
            if buf[0] != SOF:
                buf.pop(0)
                continue
            need = FRAME_LEN.get(buf[2])
            if need is None:
                buf.pop(0)
                continue
            if len(buf) < need:
                break
            payload = bytes(buf[1:need - 2])
            got_crc = struct.unpack("<H", bytes(buf[need - 2:need]))[0]
            del buf[:need]
            if got_crc != crc16_modbus(payload):
                print("BAD CRC from CLI", file=sys.stderr)
                continue
            response = station.handle(payload)
            if response:
                os.write(master, frame(response))

    out, err = proc.communicate(timeout=10)
    os.close(master)
    os.close(slave)
    return proc.returncode, out.decode(), err.decode()


# --------------------------------------------------------------------------


class FillBitAlwaysSet(Station):
    """A station that sets the fill bit on every slot, empty ones included.

    Observed on a real S1TT6: `status -i 1` on an empty slot answered
    `isPowerbankPresent: true` next to `state: "empty"`, because `status` read
    occupancy from the fill bitmap while `slots` read it from the lock bitmap.
    """

    def handle(self, payload):
        addr, op, args = payload[0], payload[1], payload[2:]
        if op == CMD_SLOTS:
            fill = lock = 0
            for slot in range(6):
                fill |= 1 << slot                   # set whatever is docked
                if self.packs.get(slot) is None:
                    lock |= 1 << slot               # empty slots read as locked
            return bytes([addr, op, 0, fill, lock])
        return super().handle(payload)


REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASELINE = None
if "--baseline" in sys.argv:
    BASELINE = os.path.abspath(sys.argv[sys.argv.index("--baseline") + 1])


def board(**kwargs):
    return Station({
        0: Pack("HEALTHY001", 13925, 13000, 10625, PB_PLUGGED_IN),  # 71%, sound
        1: Pack("BADCUTOFF1", 10000,  9000, 10625, PB_IDLE),        # cutoff >= total
        2: Pack("ZEROCAP001",     0,     0,     0, PB_IDLE),        # zeroed nameplate
        3: Pack("OVERFULL01", 13925, 60000, 10625, PB_IDLE),        # current > total
        4: None,                                                     # empty slot
        5: Pack("FULLGOOD01", 13925, 13925, 10625, PB_IDLE),        # sound, really full
    }, **kwargs)


def by_index(out):
    return {s["index"]: s for s in json.loads(out)["slots"]}


def show(slots, indices):
    for i in indices:
        pb = slots[i]["powerBank"]
        print(f"  slot {i}: {pb['id']} level={pb['powerLevel']}% "
              f"status={pb['status']} charging={slots[i]['isCharging']}")


results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))


if BASELINE:
    print("\n=== BEFORE the fix — three mis-initialized packs ===")
    st = board()
    _, out, _ = run(st, ["S1TT6", "slots"], cwd=BASELINE)
    slots = by_index(out)
    show(slots, (2, 3, 4))
    check("baseline: no parameters are ever rewritten", st.battery_writes == [])
    check("baseline: every bad pack reports a nonsense level",
          [slots[i]["powerBank"]["powerLevel"] for i in (2, 3, 4)] == [0, 0, 1496],
          "0% for the two starved packs, 1496% for the over-full one")
    check("baseline: none of them is ever charged",
          all(slots[i]["isCharging"] is False for i in (2, 3, 4)))

print("\n=== three mis-initialized packs, one healthy, one genuinely full ===")
st = board()
rc, out, err = run(st, ["S1TT6", "slots"], cwd=REPO)
slots = by_index(out)
show(slots, (1, 2, 3, 4, 6))
print("  battery writes:", st.battery_writes)
print("  charge commands:", st.charge_cmds)

check("exactly the three bad packs are reset",
      sorted(w[0] for w in st.battery_writes) == [1, 2, 3], str(st.battery_writes))
check("every reset writes the factory defaults",
      all(w[1:] == DEFAULTS for w in st.battery_writes))
check("the sound packs are never written",
      all(w[0] not in (0, 5) for w in st.battery_writes))
check("the repaired packs report a real level instead of 0%",
      all(slots[i]["powerBank"]["powerLevel"] == 30 for i in (2, 3, 4)),
      str([slots[i]["powerBank"]["powerLevel"] for i in (2, 3, 4)]))
check("the repaired packs are no longer stuck in IDLE",
      all(slots[i]["powerBank"]["status"] == PB_PLUGGED_IN for i in (2, 3, 4)))
check("a previously stuck pack now gets the charge slot",
      slots[2]["isCharging"] is True, "index 2 = the cutoff >= total pack")
check("charging is actually enabled on the wire for it", (1, True) in st.charge_cmds)
check("the genuinely full pack is left alone",
      slots[6]["powerBank"]["powerLevel"] == 100 and slots[6]["isCharging"] is False)
check("the empty slot is still reported empty", slots[5]["powerBank"] is None)
check("no slot errors", json.loads(out)["errors"] == [])
check("the reset is logged to stderr, never into the stdout JSON",
      err.count("invalid battery") == 3 and "invalid battery" not in out)

print("\n=== the same station polled a second time ===")
_, out2, _ = run(st, ["S1TT6", "slots"], cwd=REPO)
check("a repaired pack is not rewritten on every poll", st.battery_writes[3:] == [])
check("it stays in the charging rotation", by_index(out2)[2]["isCharging"] is True)

print("\n=== pack whose firmware latches IDLE after the reset ===")
st_l = board(latch_status=True)
_, out3, _ = run(st_l, ["S1TT6", "slots"], cwd=REPO)
slots3 = by_index(out3)
show(slots3, (2, 3, 4))
check("parameters are still corrected",
      sorted(w[0] for w in st_l.battery_writes) == [1, 2, 3])
check("the level is no longer pinned at 0%",
      all(slots3[i]["powerBank"]["powerLevel"] == 30 for i in (2, 3, 4)))
check("KNOWN GAP: a latched-IDLE pack is still not charged",
      all(slots3[i]["isCharging"] is False for i in (2, 3, 4)),
      "documents the residual risk, not a regression")

print("\n=== pack that NACKs the reset ===")
st_r = board(refuse_writes=True)
rc4, out4, _ = run(st_r, ["S1TT6", "slots"], cwd=REPO)
check("the reset is attempted once per bad pack, not retried in a loop",
      [w[0] for w in st_r.battery_writes] == [1, 2, 3])
check("a refused reset degrades gracefully: valid JSON, no crash",
      rc4 == 0 and json.loads(out4)["errors"] == [])
check("the healthy pack still charges when the bad ones cannot be fixed",
      by_index(out4)[1]["isCharging"] is True)

print("\n=== pack that stops answering after the reset ===")
st_f = board(fail_reread=True)
rc5, out5, _ = run(st_f, ["S1TT6", "slots"], cwd=REPO)
check("the parameters are still written",
      sorted(w[0] for w in st_f.battery_writes) == [1, 2, 3])
check("a failed re-read degrades gracefully: valid JSON, no crash",
      rc5 == 0 and isinstance(json.loads(out5)["slots"], list))

print("\n=== occupancy: station sets the fill bit on empty slots too ===")


def presence_board():
    return FillBitAlwaysSet({0: None,
                             1: Pack("REALPACK01", 13925, 12000, 10625, PB_PLUGGED_IN)})


_, empty_out, _ = run(presence_board(), ["S1TT6", "status", "-i", "1"], cwd=REPO)
_, full_out, _ = run(presence_board(), ["S1TT6", "status", "-i", "2"], cwd=REPO)
_, list_out, _ = run(presence_board(), ["S1TT6", "slots"], cwd=REPO)
empty_slot = json.loads(empty_out)["slot"]
full_slot = json.loads(full_out)["slot"]
listed = by_index(list_out)
print(f"  status -i 1 (empty)    present={empty_slot['isPowerbankPresent']} "
      f"state={empty_slot['state']}")
print(f"  status -i 2 (occupied) present={full_slot['isPowerbankPresent']} "
      f"state={full_slot['state']}")

check("status does not report a powerbank in an empty slot",
      empty_slot["isPowerbankPresent"] is False)
check("status stays self-consistent: empty state implies no powerbank",
      empty_slot["state"] == "empty" and empty_slot["powerBank"] is None)
check("status still reports an occupied slot as occupied",
      full_slot["isPowerbankPresent"] is True and full_slot["powerBank"]["id"] == "REALPACK01")
check("status and slots agree about every slot",
      empty_slot["isPowerbankPresent"] == listed[1]["isPowerbankPresent"]
      and full_slot["isPowerbankPresent"] == listed[2]["isPowerbankPresent"])
check("the fill bit is reported separately instead of being dropped",
      empty_slot["isSlotFilled"] is True and full_slot["isSlotFilled"] is True,
      "this station sets it on empty slots too, which is the point")
check("status passes through the telemetry it already read",
      {k: full_slot["powerBank"][k] for k in
       ("timestamp", "totalCharge", "currentCharge", "cutoffCharge", "cycles")}
      == {"timestamp": 1740000000, "totalCharge": 13925, "currentCharge": 12000,
          "cutoffCharge": 10625, "cycles": 12},
      str({k: full_slot["powerBank"].get(k) for k in
           ("totalCharge", "currentCharge", "cutoffCharge", "cycles")}))

print("\n" + "=" * 62)
failed = [n for n, ok, _ in results if not ok]
print(f"{len(results) - len(failed)}/{len(results)} checks passed")
for name in failed:
    print("  FAILED:", name)
sys.exit(1 if failed else 0)
