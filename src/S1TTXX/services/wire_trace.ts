// --raw: read back what the station itself did on the pogo link for the last
// powerbank request (HOST_CMD_PB_WIRE_TRACE, 0x53) and print it next to the
// CLI's own frames.
//
// Only station firmware built with CONFIG_AMPERRY_TRACE_WIRE (debug_trace.conf;
// the -trace image of a dev release) records this; other builds answer
// ERR_INVALID_TYPE and a one-line notice is printed instead.
//
// One host request can take several pogo exchanges: STATUS first sends
// PB_CMD_INFO_EXT and, when an older powerbank rejects it, PB_CMD_INFO. Every
// exchange is shown, with every attempt of the station's retry chain.
//
// Two limits shape what is shown:
// - Paging: one station reply on the host link carries at most 50 bytes, so
//   the station returns its log in pages of 40 bytes and the CLI joins them.
//   Every trace says how many bytes and pages were read, and flags a log that
//   could not be read completely.
// - RAM: the station keeps at most 192 bytes per request. Each request frame
//   is stored once (retries re-send it unchanged); bytes, attempts and
//   exchanges that did not fit are reported as such. A STATUS with the
//   fallback (two exchanges, 178 bytes) always fits.
//
// Log layout, version 3 (S1TTXX-firmware inc/pb_wire_log.h):
//   [version][slot][n_ex_recorded][n_ex_seen]
//   exchange: [pb_cmd][flags][tx_len][tx bytes][n_att_recorded][n_att_seen]
//   attempt:  [outcome | 0x80 if cut][drained u16 LE][rx_len][rx bytes]

import type { SerialService } from "./serial";
import { CMD_PB_WIRE_TRACE, STATUS_ERR_INVALID_CMD } from "../../utils/constants";
import { hex, rawTrace } from "../../utils/test_modes";

export const WIRE_TRACE_PAGE_LEN = 40;
export const STATION_LOG_BUDGET = 192;
const LOG_VERSION = 3;
const MAX_PAGES = 8; // 192 bytes = 5 pages; a little slack for future builds
const RX_CUT = 0x80;
const TX_CUT = 0x01;

const OUTCOMES: Record<number, string> = {
  0: "reply received and decoded",
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
  /** reply bytes were cut to fit the station's log */
  truncated: boolean;
}

export interface WireExchange {
  pbCommand: number;
  tx: Buffer;
  /** request frame was cut to fit the station's log */
  txCut: boolean;
  /** attempts the station made; more than attempts.length when some did not fit */
  seen: number;
  attempts: WireAttempt[];
}

export interface WireRecord {
  version: number;
  slot: number;
  /** exchanges the station made; more than exchanges.length when some did not fit */
  seen: number;
  exchanges: WireExchange[];
  /** the log itself ended early (a page was not read) */
  incomplete: boolean;
}

/** Parse a (possibly incomplete) version-3 log; never throws. */
export function parseWireRecord(record: Buffer): WireRecord | null {
  if (record.length < 4 || record[0] !== LOG_VERSION) return null;
  const out: WireRecord = { version: record[0], slot: record[1], seen: record[3], exchanges: [], incomplete: false };
  let p = 4;
  for (let e = 0; e < record[2]; e++) {
    if (p + 3 > record.length) {
      out.incomplete = true;
      break;
    }
    const txLen = record[p + 2];
    const ex: WireExchange = {
      pbCommand: record[p],
      txCut: (record[p + 1] & TX_CUT) !== 0,
      tx: record.subarray(p + 3, Math.min(p + 3 + txLen, record.length)),
      seen: 0,
      attempts: [],
    };
    out.exchanges.push(ex);
    p += 3 + txLen;
    if (p + 2 > record.length) {
      out.incomplete = true;
      break;
    }
    const recorded = record[p];
    ex.seen = record[p + 1];
    p += 2;
    for (let a = 0; a < recorded; a++) {
      if (p + 4 > record.length) {
        out.incomplete = true;
        break;
      }
      const rxLen = record[p + 3];
      const rx = record.subarray(p + 4, Math.min(p + 4 + rxLen, record.length));
      if (rx.length < rxLen) out.incomplete = true;
      ex.attempts.push({
        outcome: record[p] & ~RX_CUT,
        truncated: (record[p] & RX_CUT) !== 0,
        drained: record.readUInt16LE(p + 1),
        rx,
      });
      p += 4 + rxLen;
    }
    if (out.incomplete) break;
  }
  return out;
}

const cmdName = (c: number) => `0x${c.toString(16).padStart(2, "0")} ${PB_COMMANDS[c] ?? "unknown"}`;

let unsupportedNoticeShown = false;

/**
 * Fetch the station's log of the last powerbank request on `board` and
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
            "(needs CONFIG_AMPERRY_TRACE_WIRE: the -trace image of an S1TTXX-firmware dev release, or debug_trace.conf)"
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
    `board ${board}: station's own pogo-link log of the last powerbank request — ` +
      `${record.length}${complete ? "" : ` of ${total}`} bytes in ${pages.length} page(s) of ` +
      `${WIRE_TRACE_PAGE_LEN} bytes (a station reply carries at most 50 bytes, so the CLI reads the ` +
      `log in pages and joins them; the station keeps at most ${STATION_LOG_BUDGET} bytes per request)`
  );
  if (!complete) {
    rawTrace("STATION", `INCOMPLETE log: ${failure ?? "fewer bytes than announced"}; entries below may be cut short`);
  }

  const rec = parseWireRecord(record);
  if (rec === null) {
    rawTrace(
      "STATION",
      record.length === 0 || record[0] === LOG_VERSION
        ? "no powerbank request recorded yet"
        : `log format v${record[0]} not understood by this CLI (expects v${LOG_VERSION}): use the matching station-cli`
    );
    return;
  }
  rawTrace(
    "STATION",
    `slot ${rec.slot + 1} (station slot ${rec.slot}): ${rec.seen} pogo exchange(s) for this request`
  );

  rec.exchanges.forEach((ex, e) => {
    const x = `[${e + 1}]`;
    rawTrace(
      "STATION",
      `${x} cmd=${cmdName(ex.pbCommand)}: ${ex.seen} attempt(s); pogo TX ${ex.tx.length} bytes [${hex(ex.tx)}]` +
        (ex.txCut ? ` (cut short to fit the station's ${STATION_LOG_BUDGET}-byte log)` : "") +
        (ex.seen > 1 ? " (same frame on every attempt)" : "")
    );
    ex.attempts.forEach((a, i) => {
      const n = `${x}#${i + 1}`;
      if (a.drained > 0) {
        rawTrace("STATION", `${n} ${a.drained} noise byte(s) were discarded before the reply window`);
      }
      if (a.rx.length > 0 || a.truncated) {
        const cut = a.truncated
          ? ` (cut short: only the first ${a.rx.length} bytes fit the station's ${STATION_LOG_BUDGET}-byte log)`
          : "";
        rawTrace("STATION", `${n} pogo RX ${a.rx.length} bytes [${hex(a.rx)}]${cut}`);
      }
      rawTrace("STATION", `${n} result: ${OUTCOMES[a.outcome] ?? `outcome ${a.outcome}`}`);
    });
    if (ex.seen > ex.attempts.length && !rec.incomplete) {
      rawTrace(
        "STATION",
        `${x} attempts #${ex.attempts.length + 1}-#${ex.seen} not shown: they did not fit the station's ${STATION_LOG_BUDGET}-byte log`
      );
    }
    // The station decrypts the reply, the log keeps the wire bytes: a
    // rejected INFO_EXT is only visible as the INFO exchange that follows it.
    const next = rec.exchanges[e + 1];
    if (ex.pbCommand === 0x08 && next && next.pbCommand === 0x01) {
      rawTrace(
        "STATION",
        `${x} the powerbank rejected PB_CMD_INFO_EXT (firmware older than the extended status), ` +
          `so the station fell back to PB_CMD_INFO`
      );
    }
  });
  if (rec.seen > rec.exchanges.length && !rec.incomplete) {
    rawTrace(
      "STATION",
      `exchanges [${rec.exchanges.length + 1}]-[${rec.seen}] not shown: they did not fit the station's ${STATION_LOG_BUDGET}-byte log`
    );
  }
  if (rec.incomplete) {
    rawTrace("STATION", "log ends early (a page was not read): the entries above may be incomplete");
  }
}
