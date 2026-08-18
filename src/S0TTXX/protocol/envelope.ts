/**
 * S0TTXX cloud envelope (docs/CLOUD_PROTOCOL.md §3) — the wire format the
 * gateway speaks over BOTH the local serial connector and (later) MQTT. The
 * CLI builds downlink `cmd` envelopes and reads uplink envelopes back; the
 * gateway firmware wraps the `cmd` into a real `{..}` main-board frame (adding
 * the CRC-16/MODBUS itself), so the CLI never computes CRCs.
 */

export interface Envelope {
  v?: number;
  id?: string;
  seq?: number;
  ts?: number;
  t: string; // "cmd" | "cfg" | "ota" (downlink) | "hello"|"hb"|"evt"|"tlm"|"resp" (uplink)
  mid?: number;
  d?: any;
}

/** A downlink `cmd` payload (§5.4). */
export interface CmdPayload {
  mnem: string; // 2-char main-board mnemonic, e.g. "FB", "CQ"
  body?: string; // comma-separated fields WITHOUT framing/CRC, e.g. "0,<ts>,<slot>"
  addr?: string; // optional relay address char → "{<addr>@MNEM,..}" form
  prefix?: string; // optional frame prefix (default "{")
}

let midCounter = 0;

/**
 * Correlation id for a downlink command. Kept small and monotonic (the firmware
 * treats `mid` as a uint32 and echoes it on the matching `resp`); do NOT use
 * Date.now() here — that overflows 32 bits. The incrementing "X" the OEM
 * protocol wants lives in the command BODY (a plain timestamp string), not mid.
 */
export function nextMid(): number {
  midCounter = (midCounter % 0x7fffffff) + 1;
  return midCounter;
}

/** Build a downlink `cmd` envelope. */
export function buildCmd(payload: CmdPayload, mid: number): Envelope {
  const d: CmdPayload = { mnem: payload.mnem };
  if (payload.addr !== undefined) d.addr = payload.addr;
  if (payload.prefix !== undefined) d.prefix = payload.prefix;
  if (payload.body !== undefined) d.body = payload.body;
  return { v: 1, t: "cmd", mid, d };
}

/** Parse one received line into an Envelope, or null if it isn't valid JSON
 *  with a `t` field (log noise, partial lines, etc. are ignored). */
export function parseEnvelopeLine(line: string): Envelope | null {
  const start = line.indexOf("{");
  if (start === -1) return null;
  try {
    const obj = JSON.parse(line.slice(start));
    if (obj && typeof obj === "object" && typeof obj.t === "string") {
      return obj as Envelope;
    }
  } catch {
    // not JSON — ignore
  }
  return null;
}
