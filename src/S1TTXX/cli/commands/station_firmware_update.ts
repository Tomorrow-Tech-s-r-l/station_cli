import * as fs from "node:fs";
import * as path from "node:path";

import { SerialService } from "../../services/serial";
import { StationFwuEnterCommand } from "./station_fwu_enter";
import {
  StationFwuHelloCommand,
  StationFwuHelloInfo,
} from "./station_fwu_hello";
import { StationFwuBeginCommand } from "./station_fwu_begin";
import {
  StationFwuDataCommand,
  STATION_FWU_MAX_CHUNK,
} from "./station_fwu_data";
import { StationFwuEndCommand } from "./station_fwu_end";
import { StationFwuAbortCommand } from "./station_fwu_abort";
import { StationFwuExitCommand } from "./station_fwu_exit";
import { debug } from "../../../utils/debug";

/** Same FWU_RES_* sentinel set the bootloader uses (see
 *  bootloader/Inc/fwu_iface.h). The station/CLI strips response[2] into
 *  CommandResponse.status, so success means status === 0. */
const STATUS_OK = 0x00;
const STATUS_OFFSET_MISMATCH = 0x10;

/** Settle time for the soft reset across STATION_FWU_ENTER → BL and
 *  STATION_FWU_EXIT → app. The bare-metal BL inherits HSI 8 MHz so its
 *  Reset_Handler runs in ~10 ms; the Zephyr app comes up in ~50 ms. 300 ms
 *  matches the powerbank runFirmwareUpdate() default and is plenty. */
const RESET_SETTLE_MS = 300;

export interface StationFirmwareUpdateOptions {
  /** Board address from PB4..PB7 DIP switches on the target station. */
  boardAddress: number;
  /** Path to the Zephyr application body — typically build/zephyr/zephyr.bin. */
  imagePath: string;
  /** (major<<16)|(minor<<8)|patch, stamped into the app header on END. */
  version: number;
  /** Print per-chunk progress and timing. */
  verbose?: boolean;
  /** Extra delay between consecutive DATA chunks. The transport already
   *  inserts INTER_COMMAND_DELAY_MS (50 ms) after each frame; bump this
   *  if a particular cable/transceiver pair needs more breathing room. */
  interChunkDelayMs?: number;
}

export interface StationFirmwareUpdateResult {
  success: boolean;
  imagePath: string;
  imageSize: number;
  imageCrc32: number;
  chunks: number;
  retries: number;
  durationMs: number;
  blInfo: StationFwuHelloInfo | null;
  error: { stage: string; code?: number; message: string } | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * IEEE 802.3 CRC32 (poly 0xEDB88320). Bit-exact match with the
 * bootloader's fwu_crc32_update() in bootloader/Src/fwu_crc.c and with
 * the merge.py script that builds merged.bin. Inlined here so we work on
 * Node 18 (the pkg target); Node 22's `zlib.crc32` would be the obvious
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
 * Drive the full station firmware-update handshake against a board:
 *
 *   STATION_FWU_ENTER → settle → STATION_FWU_HELLO → STATION_FWU_BEGIN
 *     → loop STATION_FWU_DATA → STATION_FWU_END → STATION_FWU_EXIT
 *     → settle
 *
 * Honors RES_OFFSET_MISMATCH (0x10) by resyncing to next_expected_offset
 * before retrying the chunk. On any other failure mid-stream, tries to
 * issue STATION_FWU_ABORT so the BL session is cleanly torn down; the BL
 * keeps the header erased so the slot is invalid until the next attempt.
 *
 * Mirrors `runFirmwareUpdate` (powerbank-side) — same staging, same
 * resync logic, same self-healing pre-flight that fires EXIT first in
 * case a previous run left the device stuck in BL.
 */
export async function runStationFirmwareUpdate(
  service: SerialService,
  opts: StationFirmwareUpdateOptions
): Promise<StationFirmwareUpdateResult> {
  const startTs = Date.now();
  const imagePath = path.resolve(opts.imagePath);
  const image = fs.readFileSync(imagePath);
  const imageSize = image.length;
  const imageCrc32 = crc32(image);

  const out: StationFirmwareUpdateResult = {
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

  const { boardAddress } = opts;

  // ------- Step 0: best-effort STATION_FWU_EXIT -----------------------
  //
  // If a previous run left the device stuck in BL mode (e.g. it bailed
  // between BEGIN and EXIT), the app-side STATION_FWU_ENTER doesn't work
  // — sending it to the BL falls in its `default:` branch and returns
  // FWU_RES_INVALID. Silently fire EXIT first: the BL acks + resets into
  // the app, then we proceed. If the device is already in app mode,
  // EXIT gets rejected (the app doesn't know 0x66) and we just lose
  // ~RESET_SETTLE_MS — acceptable price for self-healing the test loop.
  log(`[STATION-FWU] (pre-flight) station-fwu-exit to ensure app mode`);
  await new StationFwuExitCommand(service).execute(boardAddress).catch(() => {});
  await sleep(RESET_SETTLE_MS);

  // ------- Step 1: STATION_FWU_ENTER ---------------------------------
  log(`[STATION-FWU] station-fwu-enter (board=${boardAddress})`);
  const enter = await new StationFwuEnterCommand(service).execute(boardAddress);
  if (!enter.success) {
    out.error = { stage: "STATION_FWU_ENTER", code: enter.status, message: "App did not ack" };
    out.durationMs = Date.now() - startTs;
    return out;
  }
  await sleep(RESET_SETTLE_MS);

  // ------- Step 2: STATION_FWU_HELLO ---------------------------------
  log(`[STATION-FWU] station-fwu-hello`);
  const hello = await new StationFwuHelloCommand(service).execute(boardAddress);
  if (!hello.success || hello.data.length === 0) {
    out.error = {
      stage: "STATION_FWU_HELLO",
      code: hello.status,
      message: "Bootloader did not answer HELLO",
    };
    out.durationMs = Date.now() - startTs;
    return out;
  }
  try {
    out.blInfo = JSON.parse(hello.data.toString()) as StationFwuHelloInfo;
  } catch {
    out.error = { stage: "STATION_FWU_HELLO", message: "Malformed HELLO payload" };
    out.durationMs = Date.now() - startTs;
    return out;
  }
  if (out.blInfo.slotSize < imageSize) {
    out.error = {
      stage: "STATION_FWU_HELLO",
      message: `Image too large: ${imageSize} B > slot ${out.blInfo.slotSize} B`,
    };
    out.durationMs = Date.now() - startTs;
    return out;
  }
  const maxChunk = Math.min(
    out.blInfo.maxChunk || STATION_FWU_MAX_CHUNK,
    STATION_FWU_MAX_CHUNK
  );
  log(
    `[STATION-FWU] BL=${out.blInfo.blVersionMajor}.${out.blInfo.blVersionMinor}  ` +
      `slotSize=${out.blInfo.slotSize}  pageSize=${out.blInfo.pageSize}  ` +
      `maxChunk=${maxChunk}  image=${imageSize}B crc32=0x${imageCrc32.toString(16).padStart(8, "0")}`
  );

  // ------- Step 3: STATION_FWU_BEGIN ---------------------------------
  log(
    `[STATION-FWU] station-fwu-begin size=${imageSize} crc32=0x${imageCrc32.toString(16)} version=0x${opts.version.toString(16)}`
  );
  const begin = await new StationFwuBeginCommand(service).execute(boardAddress, {
    imgSize: imageSize,
    imgCrc32: imageCrc32,
    version: opts.version,
  });
  if (!begin.success) {
    out.error = { stage: "STATION_FWU_BEGIN", code: begin.status, message: "BL rejected BEGIN" };
    out.durationMs = Date.now() - startTs;
    return out;
  }

  // ------- Step 4: stream STATION_FWU_DATA chunks --------------------
  let offset = 0;
  const dataCmd = new StationFwuDataCommand(service);
  while (offset < imageSize) {
    const remaining = imageSize - offset;
    const chunkLen = Math.min(maxChunk, remaining);
    const chunk = image.subarray(offset, offset + chunkLen);
    log(
      `[STATION-FWU] station-fwu-data offset=${offset} len=${chunkLen} ` +
        `(${(((offset + chunkLen) / imageSize) * 100).toFixed(1)}%)`
    );
    const r = await dataCmd.execute(boardAddress, { offset, bytes: chunk });
    out.chunks++;
    if (r.success && r.info) {
      offset = r.info.nextExpectedOffset;
      if ((opts.interChunkDelayMs ?? 0) > 0) {
        await sleep(opts.interChunkDelayMs as number);
      }
      continue;
    }
    if (r.status === STATUS_OFFSET_MISMATCH && r.info) {
      log(`[STATION-FWU] OFFSET_MISMATCH — resync to ${r.info.nextExpectedOffset}`);
      offset = r.info.nextExpectedOffset;
      out.retries++;
      continue;
    }
    out.error = {
      stage: "STATION_FWU_DATA",
      code: r.status,
      message: `DATA failed at offset ${offset}`,
    };
    /* Best-effort cleanup — keep the slot in a known invalid state. */
    await new StationFwuAbortCommand(service).execute(boardAddress).catch(() => {});
    out.durationMs = Date.now() - startTs;
    return out;
  }

  // ------- Step 5: STATION_FWU_END -----------------------------------
  log(`[STATION-FWU] station-fwu-end (verifying CRC32 + writing header)`);
  const end = await new StationFwuEndCommand(service).execute(boardAddress);
  if (!end.success) {
    out.error = {
      stage: "STATION_FWU_END",
      code: end.status,
      message: "BL rejected END (CRC mismatch?)",
    };
    await new StationFwuAbortCommand(service).execute(boardAddress).catch(() => {});
    out.durationMs = Date.now() - startTs;
    return out;
  }

  // ------- Step 6: STATION_FWU_EXIT ----------------------------------
  log(`[STATION-FWU] station-fwu-exit (reset into new app)`);
  const exit = await new StationFwuExitCommand(service).execute(boardAddress);
  if (!exit.success) {
    out.error = {
      stage: "STATION_FWU_EXIT",
      code: exit.status,
      message: "BL did not ack EXIT",
    };
    out.durationMs = Date.now() - startTs;
    return out;
  }
  await sleep(RESET_SETTLE_MS);

  out.success = true;
  out.durationMs = Date.now() - startTs;
  return out;
}
