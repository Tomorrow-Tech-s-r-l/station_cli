// Testing modes: switched on by the global --raw and --no-retry flags.
// Not used by the kiosk app; they exist to debug powerbank logic and replies.
//
// Everything they print goes to stderr, so stdout keeps carrying exactly the
// one JSON result that other programs parse.

let raw = false;
let noRetry = false;

export function setRawMode(enabled: boolean): void {
  raw = enabled;
}

export function isRawMode(): boolean {
  return raw;
}

export function setNoRetryMode(enabled: boolean): void {
  noRetry = enabled;
}

export function isNoRetryMode(): boolean {
  return noRetry;
}

export function hex(data: Buffer): string {
  return data.toString("hex").match(/.{2}/g)?.join(" ") ?? "";
}

/** A testing-mode notice on stderr, printed whatever --raw says. */
export function testNotice(message: string): void {
  process.stderr.write(`[TEST] ${message}\n`);
}

/** One --raw trace line on stderr: `[RAW +12ms] TX ...`. */
export function rawTrace(label: string, detail: string): void {
  if (!raw) return;
  process.stderr.write(`[RAW +${Math.round(performance.now())}ms] ${label.padEnd(9)} ${detail}\n`);
}

