// --raw: read back what the station itself did on the pogo link during the
// last powerbank exchange (HOST_CMD_PB_WIRE_TRACE, 0x53) and print it next
// to the CLI's own frames.
//
// Only station firmware built with CONFIG_AMPERRY_TRACE_WIRE (the CI
// "trace-binaries" artifact) records this; other builds answer
// ERR_INVALID_TYPE and a one-line notice is printed instead.
//
// Paging: a pogo frame can be up to 85 bytes and the record holds up to three
// attempts, but one station reply on the host link carries at most 50 bytes.
// The station therefore returns the record in pages of 40 bytes and the CLI
// reassembles them. Every trace says how many bytes and pages were read, and
// flags a record that could not be read completely.
//
// Record layout, version 1 (S1TTXX-firmware inc/pb_wire_log.h):
//   [version][slot][pb_cmd_type][n_attempts]
//   n_attempts × [outcome][drained u16 LE][tx_len][rx_len][tx bytes][rx bytes]

import type { SerialService } from "./serial";
import { CMD_PB_WIRE_TRACE, STATUS_ERR_INVALID_CMD } from "../../utils/constants";
import { hex, rawTrace } from "../../utils/test_modes";

export const WIRE_TRACE_PAGE_LEN = 40;
// One record is 4 + 3 × (5 + 2 × 85) = 529 bytes at most: 14 pages.
const MAX_PAGES = 16;

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
  tx: Buffer;
  rx: Buffer;
  truncated: boolean;
}

export interface WireRecord {
  version: number;
  slot: number;
  pbCommand: number;
  attempts: WireAttempt[];
}

/** Parse a (possibly incomplete) record; never throws. */
export function parseWireRecord(record: Buffer): WireRecord | null {
  if (record.length < 4) return null;
  const out: WireRecord = {
    version: record[0],
    slot: record[1],
    pbCommand: record[2],
    attempts: [],
  };
  let p = 4;
  for (let i = 0; i < record[3] && p + 5 <= record.length; i++) {
    const outcome = record[p];
    const drained = record.readUInt16LE(p + 1);
    const txLen = record[p + 3];
    const rxLen = record[p + 4];
    p += 5;
    const tx = record.subarray(p, Math.min(p + txLen, record.length));
    p += txLen;
    const rx = record.subarray(Math.min(p, record.length), Math.min(p + rxLen, record.length));
    p += rxLen;
    out.attempts.push({ outcome, drained, tx, rx, truncated: tx.length < txLen || rx.length < rxLen });
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
      `log in pages and joins them; frames are shown whole, up to 85 bytes)`
  );
  if (!complete) {
    rawTrace("STATION", `INCOMPLETE log: ${failure ?? "fewer bytes than announced"}; frames below may be cut short`);
  }

  const rec = parseWireRecord(record);
  if (rec === null) {
    rawTrace("STATION", "no exchange recorded yet");
    return;
  }
  const name = PB_COMMANDS[rec.pbCommand] ?? "unknown";
  rawTrace(
    "STATION",
    `slot ${rec.slot + 1} (station slot ${rec.slot}) cmd=0x${rec.pbCommand.toString(16).padStart(2, "0")} ${name}: ` +
      `${rec.attempts.length} attempt(s) on the pogo link`
  );
  rec.attempts.forEach((a, i) => {
    const n = `#${i + 1}`;
    const cut = a.truncated ? " (cut short: log incomplete)" : "";
    rawTrace("STATION", `${n} pogo TX ${a.tx.length} bytes [${hex(a.tx)}]${cut}`);
    if (a.drained > 0) {
      rawTrace("STATION", `${n} ${a.drained} noise byte(s) were discarded before the reply window`);
    }
    if (a.rx.length > 0) {
      rawTrace("STATION", `${n} pogo RX ${a.rx.length} bytes [${hex(a.rx)}]${cut}`);
    }
    rawTrace("STATION", `${n} result: ${OUTCOMES[a.outcome] ?? `outcome ${a.outcome}`}`);
  });
}
