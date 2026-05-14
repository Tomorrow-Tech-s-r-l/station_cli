import * as fs from "node:fs";
import * as path from "node:path";

import { SerialService } from "../../services/serial";
import { EnterBootCommand } from "./enter_boot";
import { FwuHelloCommand, FwuHelloInfo } from "./fwu_hello";
import { FwuBeginCommand } from "./fwu_begin";
import { FwuDataCommand } from "./fwu_data";
import { FwuEndCommand } from "./fwu_end";
import { FwuAbortCommand } from "./fwu_abort";
import { FwuExitCommand } from "./fwu_exit";
import { debug } from "../../../utils/debug";

/** Phase 3+ on-target sentinel for "the command was accepted" — the
 *  station strips opcode/status into response[2], so success means
 *  response.status === 0 in CommandResponse. */
const STATUS_OK = 0x00;
const STATUS_OFFSET_MISMATCH = 0x10;

/** FWU_MAX_CHUNK on the firmware side. The bootloader rejects DATA chunks
 *  larger than 32 B today (see FWU_MAX_CHUNK in App/Inc/fwu_iface.h). The
 *  bootloader reports it in FWU_HELLO so we double-check before streaming. */
const DEFAULT_MAX_CHUNK = 32;

/** Time to wait for the device to come back online after a soft reset
 *  (ENTER_BOOT → BL; FWU_EXIT → app). At HSI 8 MHz the BL needs ~30 ms;
 *  the app at 48 MHz needs ~5 ms. 300 ms is generous and matches the
 *  tests/bootloader_phase3.sh default. */
const RESET_SETTLE_MS = 300;

export interface FirmwareUpdateOptions {
  /** Slot index, board+slot routed through mapSlotToBoard() upstream. */
  boardAddress: number;
  slotInBoard: number;
  /** Path to the raw .bin to flash. The CRC32 is computed over its bytes. */
  imagePath: string;
  /** (major<<16)|(minor<<8)|patch, stamped into the app header on END. */
  version: number;
  /** Print per-chunk progress and timing. */
  verbose?: boolean;
  /** Extra delay between consecutive DATA chunks. Useful when the BL needs
   *  more breathing room after the half-duplex direction switch than the
   *  station's natural 50 ms inter-command delay provides. Default 0. */
  interChunkDelayMs?: number;
}

export interface FirmwareUpdateResult {
  success: boolean;
  imagePath: string;
  imageSize: number;
  imageCrc32: number;
  chunks: number;
  retries: number;
  durationMs: number;
  blInfo: FwuHelloInfo | null;
  error: { stage: string; code?: number; message: string } | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * IEEE 802.3 CRC32 (poly 0xEDB88320) — bit-exact match with the
 * bootloader's fwu_crc32_update() in bootloader/Src/fwu_crc32.c, and with
 * `crc32` from Python/zlib. Inlined here so we work on Node 18 (the
 * binary target via `pkg`); Node 22's `zlib.crc32` would be the obvious
 * one-liner but isn't available there.
 */
function crc32(data: Buffer): number {
  let crc = 0xffffffff >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (crc ^ data[i]) >>> 0;
    for (let b = 0; b < 8; b++) {
      const mask = -(crc & 1) >>> 0;
      crc = ((crc >>> 1) ^ (0xedb88320 & mask)) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Drive the full Phase 5 firmware-update handshake against a slot:
 *
 *   ENTER_BOOT → settle → FWU_HELLO → FWU_BEGIN → loop FWU_DATA
 *               → FWU_END → FWU_EXIT → settle
 *
 * Honors RES_OFFSET_MISMATCH (0x10) by resyncing to next_expected_offset
 * before retrying the chunk. On any other failure mid-stream, tries to
 * issue FWU_ABORT so the BL session is cleanly torn down; the BL keeps
 * the header erased so the slot is invalid until the next attempt.
 */
export async function runFirmwareUpdate(
  service: SerialService,
  opts: FirmwareUpdateOptions
): Promise<FirmwareUpdateResult> {
  const startTs = Date.now();
  const imagePath = path.resolve(opts.imagePath);
  const image = fs.readFileSync(imagePath);
  const imageSize = image.length;
  const imageCrc32 = crc32(image);

  const out: FirmwareUpdateResult = {
    success: false,
    imagePath,
    imageSize,
    imageCrc32,
    chunks: 0,
    retries: 0,
    durationMs: 0,
    blInfo: null,
    error: null,
  };

  const log = (msg: string) => {
    if (opts.verbose) debug.log(msg);
  };

  const { boardAddress, slotInBoard } = opts;

  // ------- Step 0: best-effort FWU_EXIT ------------------------------
  //
  // If a previous run left the device stuck in BL mode (e.g. it bailed
  // between BEGIN and EXIT), the app-side opcodes don't work — sending
  // ENTER_BOOT to the BL would fall in its `default:` branch and return
  // FWU_RES_INVALID. Silently fire FWU_EXIT first: the BL acks + resets
  // into the app, then we proceed. If the device is already in app mode,
  // FWU_EXIT gets rejected (the app doesn't know 0x16) and we just lose
  // ~RESET_SETTLE_MS — acceptable price for self-healing the test loop.
  log(`[FWU] (pre-flight) fwu-exit to ensure app mode`);
  await new FwuExitCommand(service).execute(boardAddress, slotInBoard).catch(() => {});
  await sleep(RESET_SETTLE_MS);

  // ------- Step 1: ENTER_BOOT ---------------------------------------
  log(`[FWU] enter-boot (board=${boardAddress}, slot=${slotInBoard})`);
  const enter = await new EnterBootCommand(service).execute(boardAddress, slotInBoard);
  if (!enter.success) {
    out.error = { stage: "ENTER_BOOT", code: enter.status, message: "App did not ack" };
    out.durationMs = Date.now() - startTs;
    return out;
  }
  await sleep(RESET_SETTLE_MS);

  // ------- Step 2: FWU_HELLO ----------------------------------------
  log(`[FWU] fwu-hello`);
  const hello = await new FwuHelloCommand(service).execute(boardAddress, slotInBoard);
  if (!hello.success || hello.data.length === 0) {
    out.error = { stage: "FWU_HELLO", code: hello.status, message: "Bootloader did not answer HELLO" };
    out.durationMs = Date.now() - startTs;
    return out;
  }
  try {
    out.blInfo = JSON.parse(hello.data.toString()) as FwuHelloInfo;
  } catch {
    out.error = { stage: "FWU_HELLO", message: "Malformed HELLO payload" };
    out.durationMs = Date.now() - startTs;
    return out;
  }
  if (out.blInfo.slotSize < imageSize) {
    out.error = {
      stage: "FWU_HELLO",
      message: `Image too large: ${imageSize} B > slot ${out.blInfo.slotSize} B`,
    };
    out.durationMs = Date.now() - startTs;
    return out;
  }
  const maxChunk = Math.min(out.blInfo.maxChunk || DEFAULT_MAX_CHUNK, DEFAULT_MAX_CHUNK);
  log(
    `[FWU] BL=${out.blInfo.blVersionMajor}.${out.blInfo.blVersionMinor}  ` +
      `slotSize=${out.blInfo.slotSize}  pageSize=${out.blInfo.pageSize}  ` +
      `maxChunk=${maxChunk}  image=${imageSize}B crc32=0x${imageCrc32.toString(16).padStart(8, "0")}`
  );

  // ------- Step 3: FWU_BEGIN ----------------------------------------
  log(`[FWU] fwu-begin size=${imageSize} crc32=0x${imageCrc32.toString(16)} version=0x${opts.version.toString(16)}`);
  const begin = await new FwuBeginCommand(service).execute(boardAddress, slotInBoard, {
    imgSize: imageSize,
    imgCrc32: imageCrc32,
    version: opts.version,
  });
  if (!begin.success) {
    out.error = { stage: "FWU_BEGIN", code: begin.status, message: "BL rejected BEGIN" };
    out.durationMs = Date.now() - startTs;
    return out;
  }

  // ------- Step 4: stream FWU_DATA chunks ---------------------------
  let offset = 0;
  const dataCmd = new FwuDataCommand(service);
  while (offset < imageSize) {
    const remaining = imageSize - offset;
    const chunkLen = Math.min(maxChunk, remaining);
    const chunk = image.subarray(offset, offset + chunkLen);
    log(
      `[FWU] fwu-data offset=${offset} len=${chunkLen} (${(((offset + chunkLen) / imageSize) * 100).toFixed(1)}%)`
    );
    const r = await dataCmd.execute(boardAddress, slotInBoard, { offset, bytes: chunk });
    out.chunks++;
    if (r.success && r.info) {
      offset = r.info.nextExpectedOffset;
      if ((opts.interChunkDelayMs ?? 0) > 0) {
        await sleep(opts.interChunkDelayMs as number);
      }
      continue;
    }
    if (r.status === STATUS_OFFSET_MISMATCH && r.info) {
      log(`[FWU] OFFSET_MISMATCH — resync to ${r.info.nextExpectedOffset}`);
      offset = r.info.nextExpectedOffset;
      out.retries++;
      continue;
    }
    out.error = {
      stage: "FWU_DATA",
      code: r.status,
      message: `DATA failed at offset ${offset}`,
    };
    /* Best-effort cleanup — keep the slot in a known invalid state. */
    await new FwuAbortCommand(service).execute(boardAddress, slotInBoard).catch(() => {});
    out.durationMs = Date.now() - startTs;
    return out;
  }

  // ------- Step 5: FWU_END ------------------------------------------
  log(`[FWU] fwu-end (verifying CRC32 + writing header)`);
  const end = await new FwuEndCommand(service).execute(boardAddress, slotInBoard);
  if (!end.success) {
    out.error = { stage: "FWU_END", code: end.status, message: "BL rejected END (CRC mismatch?)" };
    await new FwuAbortCommand(service).execute(boardAddress, slotInBoard).catch(() => {});
    out.durationMs = Date.now() - startTs;
    return out;
  }

  // ------- Step 6: FWU_EXIT -----------------------------------------
  log(`[FWU] fwu-exit (reset into new app)`);
  const exit = await new FwuExitCommand(service).execute(boardAddress, slotInBoard);
  if (!exit.success) {
    out.error = { stage: "FWU_EXIT", code: exit.status, message: "BL did not ack EXIT" };
    out.durationMs = Date.now() - startTs;
    return out;
  }
  await sleep(RESET_SETTLE_MS);

  out.success = true;
  out.durationMs = Date.now() - startTs;
  return out;
}
