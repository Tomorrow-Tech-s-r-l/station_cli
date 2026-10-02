import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Structured log records, one JSON object per line.
 *
 * This is the same record shape the kiosk app writes, so a station's logs from
 * both processes merge into one time-ordered stream and can be filtered by the
 * same fields. The shared schema is the contract — not a shared library:
 *
 *   { "v":1, "ts":"2026-09-26T12:03:12.481Z", "lvl":"warn", "cat":"firmware",
 *     "svc":"fwu_engine", "src":"station-cli", "trace":"fwu-7f3a2c",
 *     "msg":"…", "ctx":{ "slot":13 } }
 *
 * `ts` is always UTC with a `Z` suffix: unambiguous, and it sorts correctly as
 * text when streams from different processes are merged.
 *
 * Logging must never be the reason a flash fails, so every write is
 * best-effort: an unwritable file, a full disk or a rotation race is swallowed.
 * Records never go to stdout, which is reserved for the command's JSON result.
 */

export type JsonlLevel = "debug" | "info" | "warn" | "error";

export interface JsonlRecord {
  v: 1;
  ts: string;
  lvl: JsonlLevel;
  cat: string;
  svc: string;
  src: "station-cli";
  trace: string | null;
  msg: string;
  ctx?: Record<string, unknown>;
}

/** Rotate once the active file passes this size. */
const MAX_BYTES = 5 * 1024 * 1024;
/** Generations kept: file, file.1, file.2. */
const GENERATIONS = 3;

export class JsonlLog {
  constructor(
    private readonly file: string | null,
    private readonly base: { cat: string; svc: string; trace: string | null }
  ) {}

  /** A logger sharing this file and trace, for a different service. */
  forService(svc: string, cat = this.base.cat): JsonlLog {
    return new JsonlLog(this.file, { ...this.base, svc, cat });
  }

  get trace(): string | null {
    return this.base.trace;
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.write("debug", msg, ctx);
  }
  info(msg: string, ctx?: Record<string, unknown>): void {
    this.write("info", msg, ctx);
  }
  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.write("warn", msg, ctx);
  }
  error(msg: string, ctx?: Record<string, unknown>): void {
    this.write("error", msg, ctx);
  }

  private write(lvl: JsonlLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (!this.file) return;
    const record: JsonlRecord = {
      v: 1,
      ts: new Date().toISOString(),
      lvl,
      cat: this.base.cat,
      svc: this.base.svc,
      src: "station-cli",
      trace: this.base.trace,
      msg,
      ...(ctx && Object.keys(ctx).length ? { ctx } : {}),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, JSON.stringify(record) + "\n");
    } catch {
      // best-effort by design
    }
  }

  private rotateIfNeeded(): void {
    const file = this.file as string;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < MAX_BYTES) return;
    for (let i = GENERATIONS - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      try {
        fs.renameSync(from, `${file}.${i}`);
      } catch {
        // a missing generation is fine
      }
    }
  }
}

/** A short, log-friendly correlation id: `fwu-7f3a2c`. */
export function newTraceId(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}`;
}
