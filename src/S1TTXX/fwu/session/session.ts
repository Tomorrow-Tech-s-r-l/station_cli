import * as fs from "node:fs";
import * as path from "node:path";

import { SerialService } from "../../services/serial";
import { debug } from "../../../utils/debug";
import { crc32 } from "./crc32";
import { FwuTarget } from "./target";
import { FwuHelloInfo, FwuWire, FWU_MAX_CHUNK } from "./wire";

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

export interface FwuSessionOptions {
  /** Raw application-only image. */
  imagePath: string;
  /** `(major<<16)|(minor<<8)|patch`, stamped into the app header on END. */
  version: number;
  /** Print per-step progress. */
  verbose?: boolean;
  /** Extra delay between consecutive DATA chunks. */
  interChunkDelayMs?: number;
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
  log(`${label.enter} (${target.addressLabel})`);
  const enter = await wire.enter();
  if (!enter.success) {
    return fail({ stage: stages.enter, code: enter.status, message: "App did not ack" });
  }
  await sleep(RESET_SETTLE_MS);

  // ------- Step 2: HELLO ---------------------------------------------
  log(label.hello);
  const hello = await wire.hello();
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
  let offset = 0;
  while (offset < imageSize) {
    const chunkLen = Math.min(maxChunk, imageSize - offset);
    const chunk = image.subarray(offset, offset + chunkLen);
    log(
      `${label.data} offset=${offset} len=${chunkLen} ` +
        `(${(((offset + chunkLen) / imageSize) * 100).toFixed(1)}%)`
    );
    const r = await wire.data({ offset, bytes: chunk, isFinal: offset + chunkLen === imageSize });
    out.chunks++;

    /* V-19: never trust next_expected_offset beyond the image. A glitched or
     * compromised bootloader returning 0xFFFFFFFF would otherwise set the
     * offset past the end, make every later chunk zero bytes long, and spin
     * this loop forever. Checked before the success test on purpose. */
    if (r.info && r.info.nextExpectedOffset > imageSize) {
      await abort();
      return fail({
        stage: stages.data,
        code: r.status,
        message:
          `${target.deviceNoun} returned next_expected_offset=${r.info.nextExpectedOffset} ` +
          `> imageSize=${imageSize} (V-19)`,
      });
    }
    if (r.success && r.info) {
      offset = r.info.nextExpectedOffset;
      if ((opts.interChunkDelayMs ?? 0) > 0) {
        await sleep(opts.interChunkDelayMs as number);
      }
      continue;
    }
    if (r.status === STATUS_OFFSET_MISMATCH && r.info) {
      log(`OFFSET_MISMATCH — resync to ${r.info.nextExpectedOffset}`);
      offset = r.info.nextExpectedOffset;
      out.retries++;
      continue;
    }
    await abort();
    return fail({ stage: stages.data, code: r.status, message: `DATA failed at offset ${offset}` });
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
