// --raw: read back what the station itself did on the pogo link during the
// last powerbank exchange (HOST_CMD_PB_WIRE_TRACE, 0x53) and print it next
// to the CLI's own frames.
//
// Only station firmware built with CONFIG_AMPERRY_TRACE_WIRE (the CI
// "trace-binaries" artifact) records this; other builds answer
// ERR_INVALID_TYPE and a one-line notice is printed instead.
//
// Two limits shape what is shown:
// - Paging: one station reply on the host link carries at most 50 bytes, so
//   the station returns its record in pages of 40 bytes and the CLI joins
//   them. Every trace says how many bytes and pages were read, and flags a
//   record that could not be read completely.
// - RAM: the station keeps at most 128 bytes (the F030 has ~200 B spare).
//   The request is stored once (retries re-send the identical frame); reply
//   bytes that did not fit are marked "cut short", and attempts that did not
//   fit at all are counted. A STATUS exchange (35-byte request, 51-byte
//   reply, three attempts) always fits.
//
// Record layout, version 2 (S1TTXX-firmware inc/pb_wire_log.h):
//   [version][slot][pb_cmd_type][n_recorded][n_seen][tx_len][tx bytes]
//   n_recorded × [outcome | 0x80 if cut][drained u16 LE][rx_len][rx bytes]

import type { SerialService } from "./serial";
import { CMD_PB_WIRE_TRACE, STATUS_ERR_INVALID_CMD } from "../../utils/constants";
import { hex, rawTrace } from "../../utils/test_modes";

export const WIRE_TRACE_PAGE_LEN = 40;
export const STATION_LOG_BUDGET = 128;
const MAX_PAGES = 8; // 128 bytes = 4 pages; a little slack for future builds
const TRUNCATED = 0x80;

const OUTCOMES: Record<number, string> = {
  0: "reply decoded OK",
  1: "nothing received within the reply timeout",
  2: "bytes kept coming without a pause, dropped as line noise",
  3: "bytes received but rejected (start byte, length, CRC or decryption)",
};

const PB_COMMANDS: Record<number, string> = {
  0x01: "PB_CMD_INFO",
  0x02: "PB_CMD_SET_CHARGE",
  0x03: "PB_CMD_RESET",
  0x04: "PB_CMD_SET_PDO",
  0x05: "PB_CMD_SET_INFO",
  0x06: "PB_CMD_SET_BATT_INFO",
  0x07: "PB_CMD_FW_VER",
  0x08: "PB_CMD_INFO_EXT",
};

export interface WireAttempt {
  outcome: number;
  drained: number;
  rx: Buffer;
  /** reply bytes were cut to fit the station's 128-byte log */
  truncated: boolean;
}

export interface WireRecord {
  version: number;
  slot: number;
  pbCommand: number;
  tx: Buffer;
  /** attempts the station made; more than attempts.length when some did not fit */
  seen: number;
  attempts: WireAttempt[];
  /** the record itself ended early (a page was not read) */
  incomplete: boolean;
}

/** Parse a (possibly incomplete) version-2 record; never throws. */
export function parseWireRecord(record: Buffer): WireRecord | null {
  if (record.length < 6 || record[0] !== 2) return null;
  const txLen = record[5];
  const out: WireRecord = {
    version: record[0],
    slot: record[1],
    pbCommand: record[2],
    seen: record[4],
    tx: record.subarray(6, Math.min(6 + txLen, record.length)),
    attempts: [],
    incomplete: 6 + txLen > record.length,
  };
  let p = 6 + txLen;
  for (let i = 0; i < record[3]; i++) {
    if (p + 4 > record.length) {
      out.incomplete = true;
      break;
    }
    const outcome = record[p] & ~TRUNCATED;
    const truncated = (record[p] & TRUNCATED) !== 0;
    const drained = record.readUInt16LE(p + 1);
    const rxLen = record[p + 3];
    p += 4;
    const rx = record.subarray(p, Math.min(p + rxLen, record.length));
    if (rx.length < rxLen) out.incomplete = true;
    p += rxLen;
    out.attempts.push({ outcome, drained, rx, truncated });
  }
  return out;
}

let unsupportedNoticeShown = false;

/**
 * Fetch the station's record of the last powerbank exchange on `board` and
 * print it (--raw only). Failures are reported on stderr, never thrown.
 */
export async function printStationTrace(service: SerialService, board: number): Promise<void> {
  const pages: Buffer[] = [];
  let total = 0;
  let failure: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    let r: Buffer;
    try {
      r = await service.sendMessage(
        { boardAddress: board, command: CMD_PB_WIRE_TRACE, data: Buffer.from([page]) },
        { quiet: true }
      );
    } catch (error) {
      failure = `page ${page} not answered (${error instanceof Error ? error.message : error})`;
      break;
    }
    // r = [board][0x53][status][total u16][page][len][data...]
    if (r[2] === STATUS_ERR_INVALID_CMD && page === 0) {
      if (!unsupportedNoticeShown) {
        unsupportedNoticeShown = true;
        rawTrace(
          "STATION",
          "pogo-link trace not available: this station firmware is not a trace build " +
            "(needs CONFIG_AMPERRY_TRACE_WIRE, e.g. the S1TTXX-firmware CI \"trace-binaries\" artifact)"
        );
      }
      return;
    }
    if (r[2] !== 0 || r.length < 7) {
      failure = `page ${page} answered with status ${r[2]}`;
      break;
    }
    total = r.readUInt16LE(3);
    const len = r[6];
    pages.push(r.subarray(7, 7 + len));
    if (len === 0 || (page + 1) * WIRE_TRACE_PAGE_LEN >= total) break;
  }

  const record = Buffer.concat(pages);
  const complete = failure === null && record.length >= total;
  rawTrace(
    "STATION",
    `board ${board}: station's own pogo-link log of the last powerbank exchange — ` +
      `${record.length}${complete ? "" : ` of ${total}`} bytes in ${pages.length} page(s) of ` +
      `${WIRE_TRACE_PAGE_LEN} bytes (a station reply carries at most 50 bytes, so the CLI reads the ` +
      `log in pages and joins them; the station keeps at most ${STATION_LOG_BUDGET} bytes per exchange)`
  );
  if (!complete) {
    rawTrace("STATION", `INCOMPLETE log: ${failure ?? "fewer bytes than announced"}; frames below may be cut short`);
  }

  const rec = parseWireRecord(record);
  if (rec === null) {
    rawTrace(
      "STATION",
      record.length === 0 || record[0] === 2
        ? "no powerbank exchange recorded yet"
        : `log format v${record[0]} not understood by this CLI (expects v2): update station-cli`
    );
    return;
  }
  const name = PB_COMMANDS[rec.pbCommand] ?? "unknown";
  rawTrace(
    "STATION",
    `slot ${rec.slot + 1} (station slot ${rec.slot}) cmd=0x${rec.pbCommand.toString(16).padStart(2, "0")} ${name}: ` +
      `${rec.seen} attempt(s) on the pogo link`
  );
  rawTrace(
    "STATION",
    `pogo TX ${rec.tx.length} bytes [${hex(rec.tx)}] (same frame on every attempt)` +
      (rec.incomplete && rec.attempts.length === 0 ? " (log incomplete)" : "")
  );
  rec.attempts.forEach((a, i) => {
    const n = `#${i + 1}`;
    if (a.drained > 0) {
      rawTrace("STATION", `${n} ${a.drained} noise byte(s) were discarded before the reply window`);
    }
    if (a.rx.length > 0 || a.truncated) {
      const cut = a.truncated ? ` (cut short: only the first ${a.rx.length} bytes fit the station's ${STATION_LOG_BUDGET}-byte log)` : "";
      rawTrace("STATION", `${n} pogo RX ${a.rx.length} bytes [${hex(a.rx)}]${cut}`);
    }
    rawTrace("STATION", `${n} result: ${OUTCOMES[a.outcome] ?? `outcome ${a.outcome}`}`);
  });
  if (rec.seen > rec.attempts.length && !rec.incomplete) {
    rawTrace(
      "STATION",
      `attempts #${rec.attempts.length + 1}-#${rec.seen} not shown: they did not fit the station's ${STATION_LOG_BUDGET}-byte log`
    );
  }
  if (rec.incomplete) {
    rawTrace("STATION", "log ends early (a page was not read): the attempts above may be incomplete");
  }
}
