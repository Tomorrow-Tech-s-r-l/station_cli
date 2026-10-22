import * as fs from "node:fs";
import * as path from "node:path";

import { SerialService } from "../../services/serial";
import { debug } from "../../../utils/debug";
import { crc32 } from "./crc32";
import { FwuTarget } from "./target";
import { FwuChunkError, FwuHelloInfo, FwuWire, FWU_MAX_CHUNK } from "./wire";

/**
 * The firmware-update state machine, shared by station boards and powerbanks:
 *
 *   EXIT (pre-flight) → ENTER → settle → HELLO → BEGIN → DATA… → END → EXIT → settle
 *
 * This is the single implementation of the flow that `runStationFirmwareUpdate`
 * and `runPbFirmwareUpdate` used to carry as two ~280-line copies. Everything
 * device-specific — opcodes, addressing, stage names — comes from the
 * `FwuTarget`; everything here is common to both.
 *
 * Behaviour is pinned by `tests/fwu_golden.test.js`, which replays twelve
 * scenarios per device class against transcripts recorded from the original
 * two implementations.
 */

/** Settle time across the soft reset into the bootloader and back into the app. */
const RESET_SETTLE_MS = 300;

/** Bootloader status for a DATA chunk that arrived at the wrong offset. */
const STATUS_OFFSET_MISMATCH = 0x10;

/** Bootloader status: no BEGIN is open (the device reset since). */
const STATUS_NO_SESSION = 0x13;

/**
 * Board status for a relayed request the pack never answered
 * (HOST_CMD_STATUS_ERR_TIMEOUT: S1TTXX gave up after its own pogo retries).
 * The DATA payload of such a reply is NOT the pack's: the board writes
 * whatever is on its stack as next_expected_offset (S1TTXX
 * src/host_protocol.c, PB_FWU_DATA encode), so it must never be read.
 */
const STATUS_LINK_TIMEOUT = 0x01;

/**
 * How many times one DATA chunk is re-sent after the link lost it — the
 * request or its reply — before the attempt is given up, and how long to wait
 * before each re-send.
 *
 * Re-sending the same offset is always safe: both bootloaders enforce strict
 * sequential offsets and answer a chunk they already wrote with
 * OFFSET_MISMATCH + next_expected_offset (P1TT2C and S1TTXX
 * bootloader/Src/fwu_protocol.c, handle_data), which the loop below already
 * resyncs on. So a lost frame now costs one re-send instead of the whole
 * attempt (ENTER, BEGIN and every chunk from offset 0 again). The waits let
 * a glitching link settle and give a board that reset (its watchdog) time to
 * come back while the pack's bootloader still holds the open session.
 */
export const DATA_RESEND_BACKOFF_MS: readonly number[] = [250, 1_000, 2_000];

/**
 * Lost DATA frames tolerated in one session, whichever chunks they hit. Each
 * costs up to the transport's 5 s timeout, so this bounds how long a link that
 * keeps dropping frames can hold the run (~20 × 6 s) before the attempt fails.
 */
const MAX_DATA_RESENDS_PER_SESSION = 20;

export interface FwuSessionOptions {
  /** Raw application-only image. */
  imagePath: string;
  /** `(major<<16)|(minor<<8)|patch`, stamped into the app header on END. */
  version: number;
  /** Print per-step progress. */
  verbose?: boolean;
  /** Extra delay between consecutive DATA chunks. */
  interChunkDelayMs?: number;
  /**
   * Wait before each re-send of a DATA chunk the link lost; its length is the
   * number of re-sends per chunk. Default DATA_RESEND_BACKOFF_MS; tests pass
   * zeros.
   */
  dataResendBackoffMs?: readonly number[];
}

export interface FwuSessionError {
  stage: string;
  code?: number;
  message: string;
}

export interface FwuSessionResult {
  success: boolean;
  imagePath: string;
  imageSize: number;
  imageCrc32: number;
  chunks: number;
  retries: number;
  durationMs: number;
  blInfo: FwuHelloInfo | null;
  error: FwuSessionError | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runFwuSession(
  service: SerialService,
  target: FwuTarget,
  opts: FwuSessionOptions
): Promise<FwuSessionResult> {
  const startTs = Date.now();
  const imagePath = path.resolve(opts.imagePath);
  const image = fs.readFileSync(imagePath);
  const imageSize = image.length;
  const imageCrc32 = crc32(image);

  const out: FwuSessionResult = {
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

  const wire = new FwuWire(service, target);
  const { stages, stepLabels: label, logTag: tag } = target;
  const log = (msg: string) => {
    if (opts.verbose) debug.log(`${tag} ${msg}`);
  };
  const fail = (error: FwuSessionError): FwuSessionResult => {
    out.error = error;
    out.durationMs = Date.now() - startTs;
    return out;
  };
  /** Best-effort teardown: leaves the slot in a known-invalid state. */
  const abort = () => wire.abort().catch(() => {});

  // ------- Step 0: best-effort EXIT ----------------------------------
  //
  // A previous run that bailed between BEGIN and EXIT leaves the device in
  // its bootloader, where the application-side ENTER is unknown and gets
  // rejected. Firing EXIT first resets such a device back into its app. If
  // it is already in its app, EXIT is simply rejected and we lose one settle
  // period — the price of making every run self-healing.
  log(`(pre-flight) ${label.exit} to ensure app mode`);
  await wire.exit().catch(() => {});
  await sleep(RESET_SETTLE_MS);

  // ------- Step 1: ENTER ---------------------------------------------
  //
  // ENTER is an application-side command. A device whose application header
  // is invalid — the state any interrupted flash leaves behind — cannot run
  // its application at all: the pre-flight EXIT resets it straight back into
  // its bootloader, which rejects ENTER. That device is exactly the one most
  // in need of a flash, and its bootloader is already listening. So when
  // ENTER is refused, ask the bootloader directly: if HELLO is answered, carry
  // on from there (F13). If not, fail exactly as before, with ENTER's status.
  log(`${label.enter} (${target.addressLabel})`);
  const enter = await wire.enter();
  let hello;
  if (enter.success) {
    await sleep(RESET_SETTLE_MS);
    // ------- Step 2: HELLO -------------------------------------------
    log(label.hello);
    hello = await wire.hello();
  } else {
    log(`${label.enter} refused — probing for a bootloader that is already listening`);
    hello = await wire.hello();
    if (!hello.success || hello.data.length === 0) {
      return fail({ stage: stages.enter, code: enter.status, message: "App did not ack" });
    }
    log("bootloader already active (no valid application?) — recovering");
  }
  if (!hello.success || hello.data.length === 0) {
    return fail({
      stage: stages.hello,
      code: hello.status,
      message: "Bootloader did not answer HELLO",
    });
  }
  try {
    out.blInfo = JSON.parse(hello.data.toString()) as FwuHelloInfo;
  } catch {
    return fail({ stage: stages.hello, message: "Malformed HELLO payload" });
  }
  if (out.blInfo.slotSize < imageSize) {
    return fail({
      stage: stages.hello,
      message: `Image too large: ${imageSize} B > slot ${out.blInfo.slotSize} B`,
    });
  }
  const maxChunk = Math.min(out.blInfo.maxChunk || FWU_MAX_CHUNK, FWU_MAX_CHUNK);
  log(
    `BL=${out.blInfo.blVersionMajor}.${out.blInfo.blVersionMinor}  ` +
      `slotSize=${out.blInfo.slotSize}  pageSize=${out.blInfo.pageSize}  ` +
      `maxChunk=${maxChunk}  image=${imageSize}B crc32=0x${imageCrc32.toString(16).padStart(8, "0")}`
  );

  // ------- Step 3: BEGIN ---------------------------------------------
  log(
    `${label.begin} size=${imageSize} crc32=0x${imageCrc32.toString(16)} version=0x${opts.version.toString(16)}`
  );
  const begin = await wire.begin({ imgSize: imageSize, imgCrc32: imageCrc32, version: opts.version });
  if (!begin.success) {
    return fail({ stage: stages.begin, code: begin.status, message: "BL rejected BEGIN" });
  }

  // ------- Step 4: stream DATA chunks --------------------------------
  const backoff = opts.dataResendBackoffMs ?? DATA_RESEND_BACKOFF_MS;
  let offset = 0;
  let resendsHere = 0; // re-sends of the chunk at `offset` so far
  let resendsTotal = 0;
  while (offset < imageSize) {
    const chunkLen = Math.min(maxChunk, imageSize - offset);
    const chunk = image.subarray(offset, offset + chunkLen);
    log(
      `${label.data} offset=${offset} len=${chunkLen} ` +
        `(${(((offset + chunkLen) / imageSize) * 100).toFixed(1)}%)`
    );
    let r: Awaited<ReturnType<FwuWire["data"]>> | null = null;
    let thrown: unknown = null;
    try {
      r = await wire.data({ offset, bytes: chunk, isFinal: offset + chunkLen === imageSize });
    } catch (e) {
      // A host-side guard is a bug in the caller, never a lost frame.
      if (e instanceof FwuChunkError) throw e;
      thrown = e;
    }
    out.chunks++;

    // The chunk or its reply was lost: no frame back at all (the transport
    // timed out), or the board's own pogo retries got nothing from the pack.
    // Re-send the same offset; the bootloader's answer tells where it stands.
    if (thrown !== null || (r !== null && r.status === STATUS_LINK_TIMEOUT)) {
      const why =
        thrown !== null
          ? `no reply (${thrown instanceof Error ? thrown.message : String(thrown)})`
          : "the pack did not answer the board (link timeout)";
      if (resendsHere < backoff.length && resendsTotal < MAX_DATA_RESENDS_PER_SESSION) {
        log(`${label.data} offset=${offset} lost: ${why} — re-sending (${resendsHere + 1}/${backoff.length})`);
        out.retries++;
        await sleep(backoff[resendsHere]);
        resendsHere++;
        resendsTotal++;
        continue;
      }
      const after = `at offset ${offset}/${imageSize}, after ${resendsHere} re-send(s) of that chunk`;
      if (thrown !== null) {
        // Same contract as before: a device that stays silent is a transport
        // failure, reported by the engine as "stopped answering".
        throw new Error(`${thrown instanceof Error ? thrown.message : String(thrown)} (${after})`);
      }
      await abort();
      return fail({ stage: stages.data, code: r!.status, message: `DATA failed ${after}: ${why}` });
    }
    const reply = r!;

    if (reply.status === STATUS_NO_SESSION) {
      // The bootloader no longer has the session BEGIN opened: the device
      // reset since. Nothing written can be resumed; the next attempt starts
      // over from BEGIN.
      await abort();
      return fail({
        stage: stages.data,
        code: reply.status,
        message: `DATA failed at offset ${offset}: the bootloader lost its session (device reset?)`,
      });
    }

    /* V-19: never trust next_expected_offset beyond the image. A glitched or
     * compromised bootloader returning 0xFFFFFFFF would otherwise set the
     * offset past the end, make every later chunk zero bytes long, and spin
     * this loop forever. Checked before the success test on purpose. */
    if (reply.info && reply.info.nextExpectedOffset > imageSize) {
      await abort();
      return fail({
        stage: stages.data,
        code: reply.status,
        message:
          `${target.deviceNoun} returned next_expected_offset=${reply.info.nextExpectedOffset} ` +
          `> imageSize=${imageSize} (V-19)`,
      });
    }
    if (reply.success && reply.info) {
      if (reply.info.nextExpectedOffset !== offset) resendsHere = 0;
      offset = reply.info.nextExpectedOffset;
      if ((opts.interChunkDelayMs ?? 0) > 0) {
        await sleep(opts.interChunkDelayMs as number);
      }
      continue;
    }
    if (reply.status === STATUS_OFFSET_MISMATCH && reply.info) {
      log(`OFFSET_MISMATCH — resync to ${reply.info.nextExpectedOffset}`);
      if (reply.info.nextExpectedOffset !== offset) resendsHere = 0;
      offset = reply.info.nextExpectedOffset;
      out.retries++;
      continue;
    }
    await abort();
    return fail({ stage: stages.data, code: reply.status, message: `DATA failed at offset ${offset}` });
  }

  // ------- Step 5: END -----------------------------------------------
  log(`${label.end} (verifying CRC32 + writing header)`);
  const end = await wire.end();
  if (!end.success) {
    await abort();
    return fail({
      stage: stages.end,
      code: end.status,
      message: "BL rejected END (CRC mismatch?)",
    });
  }

  // ------- Step 6: EXIT ----------------------------------------------
  log(`${label.exit} (reset into new app)`);
  const exit = await wire.exit();
  if (!exit.success) {
    return fail({ stage: stages.exit, code: exit.status, message: "BL did not ack EXIT" });
  }
  await sleep(RESET_SETTLE_MS);

  out.success = true;
  out.durationMs = Date.now() - startTs;
  return out;
}
