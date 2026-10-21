import * as fs from "node:fs";
import { appendJsonlLine } from "./jsonl_log";

/**
 * Passive serial trace: every frame station-cli sends or receives, as JSONL.
 *
 * It is switched on by a marker file, not by a flag, so the kiosk's own
 * station-cli runs (slots, status, unlock...) can be traced without changing
 * how the kiosk spawns them and without restarting it: `touch` the marker to
 * start, `rm` it to stop. Each station-cli run is a new process, so the marker
 * is checked once, on the first frame, and the answer is kept.
 *
 *   marker  /var/lib/amperry-kiosk-local/serial-trace.on       (STATION_CLI_SERIAL_TRACE_MARKER)
 *   file    /var/lib/amperry-kiosk-local/logs/serial-trace.jsonl (STATION_CLI_SERIAL_TRACE_FILE)
 *
 * One record per frame: { ts, dir: "tx"|"rx", port, hex, note? }, rotated like
 * station-cli.jsonl (5 MB, .1, .2).
 *
 * Contract: it never writes to stdout (the command's JSON result) or stderr
 * (the kiosk parses it for the port-lock error), and it never throws.
 */

export const DEFAULT_SERIAL_TRACE_MARKER = "/var/lib/amperry-kiosk-local/serial-trace.on";
export const DEFAULT_SERIAL_TRACE_FILE = "/var/lib/amperry-kiosk-local/logs/serial-trace.jsonl";

export type SerialTraceDirection = "tx" | "rx";

export interface SerialTraceRecord {
  ts: string;
  dir: SerialTraceDirection;
  port: string;
  hex: string;
  note?: string;
}

/** undefined = not checked yet; null = off; a path = on, writing there. */
let target: string | null | undefined;

function resolveTarget(): string | null {
  try {
    const marker = process.env.STATION_CLI_SERIAL_TRACE_MARKER || DEFAULT_SERIAL_TRACE_MARKER;
    if (!fs.existsSync(marker)) return null;
    return process.env.STATION_CLI_SERIAL_TRACE_FILE || DEFAULT_SERIAL_TRACE_FILE;
  } catch {
    return null;
  }
}

/** Whether this process traces frames (the marker is checked only once). */
export function isSerialTraceOn(): boolean {
  if (target === undefined) target = resolveTarget();
  return target !== null;
}

/** Record one frame on the wire. Best-effort; a no-op when tracing is off. */
export function serialTrace(dir: SerialTraceDirection, port: string, data: Buffer, note?: string): void {
  if (target === null) return;
  try {
    if (!isSerialTraceOn()) return;
    const record: SerialTraceRecord = {
      ts: new Date().toISOString(),
      dir,
      port,
      hex: data.toString("hex"),
      ...(note ? { note } : {}),
    };
    appendJsonlLine(target as string, record);
  } catch {
    // tracing must never break a command
  }
}

/** Tests only: forget the cached marker check so the next frame re-reads it. */
export function resetSerialTraceForTests(): void {
  target = undefined;
}
