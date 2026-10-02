import { BaseCommand } from "../../cli/commands/base";
import { SerialService } from "../../services/serial";
import { CommandResponse } from "../../protocol/types";
import { FwuStep, FwuTarget } from "./target";

/**
 * One encoder for the seven firmware-update requests, for either device class.
 *
 * Before this existed, each request had two hand-written command classes — one
 * for a station board, one for a powerbank — that differed only in opcode and
 * a leading slot byte. The byte layouts below are exactly theirs; `target.prefix`
 * supplies the slot byte for a powerbank and nothing for a station. The golden
 * transcripts in `tests/golden/fwu/` pin every byte of that equivalence.
 *
 * The named command classes (`FwuBeginCommand`, `PbFwuDataCommand`, …) remain
 * as thin wrappers over this class, so nothing that imports them changes.
 */

/** Largest DATA chunk either bootloader accepts (FWU_MAX_CHUNK in fwu_iface.h). */
export const FWU_MAX_CHUNK = 32;

/** Bootloader protocol version this host was written against (V-40). */
export const FWU_HOST_EXPECTED_MAJOR = 0;
export const FWU_HOST_EXPECTED_MINOR = 1;

const HELLO_PAYLOAD_BYTES = 15;

/** What a bootloader reports in reply to HELLO. */
export interface FwuHelloInfo {
  blVersionMajor: number;
  blVersionMinor: number;
  appPresent: boolean;
  appVersion: number;
  maxChunk: number;
  pageSize: number;
  slotSize: number;
}

/** Reply to DATA: the offset the bootloader expects next. */
export interface FwuDataInfo {
  nextExpectedOffset: number;
}

export interface FwuBeginParams {
  imgSize: number;
  imgCrc32: number;
  version: number;
}

export interface FwuDataParams {
  offset: number;
  bytes: Buffer;
  isFinal?: boolean;
}

export class FwuWire extends BaseCommand {
  constructor(service: SerialService, readonly target: FwuTarget) {
    super(service);
  }

  /**
   * Generic dispatch, required by `BaseCommand`. The board address argument is
   * ignored in favour of the target's own; prefer the named step methods.
   */
  async execute(_boardAddress: number, step: FwuStep, body?: Buffer): Promise<CommandResponse> {
    return this.send(step, body ?? Buffer.alloc(0));
  }

  private send(step: FwuStep, body: Buffer = Buffer.alloc(0)): Promise<CommandResponse> {
    return this.executeCommand({
      boardAddress: this.target.boardAddress,
      command: this.target.opcodes[step],
      data: Buffer.concat([this.target.prefix, body]),
    });
  }

  /** Application-side: reset into the bootloader. */
  enter(): Promise<CommandResponse> {
    return this.send("enter");
  }

  /**
   * Bootloader handshake. On success the reply's `data` is replaced with the
   * parsed `FwuHelloInfo` as JSON — the shape every caller already consumes.
   */
  async hello(): Promise<CommandResponse> {
    const response = await this.send("hello");
    if (!response.success || response.data.length < HELLO_PAYLOAD_BYTES) {
      return response;
    }
    const d = response.data;
    const info: FwuHelloInfo = {
      blVersionMajor: d.readUInt8(0),
      blVersionMinor: d.readUInt8(1),
      appPresent: d.readUInt8(2) === 1,
      appVersion: d.readUInt32LE(3),
      maxChunk: d.readUInt16LE(7),
      pageSize: d.readUInt16LE(9),
      slotSize: d.readUInt32LE(11),
    };
    if (
      info.blVersionMajor !== FWU_HOST_EXPECTED_MAJOR ||
      info.blVersionMinor !== FWU_HOST_EXPECTED_MINOR
    ) {
      console.warn(
        this.target.helloVersionWarning(
          info.blVersionMajor,
          info.blVersionMinor,
          FWU_HOST_EXPECTED_MAJOR,
          FWU_HOST_EXPECTED_MINOR
        )
      );
    }
    return { ...response, data: Buffer.from(JSON.stringify(info)) };
  }

  /** Opens a session: `[size_u32][crc32_u32][version_u32]`, little-endian. */
  begin(params: FwuBeginParams): Promise<CommandResponse> {
    const body = Buffer.alloc(12);
    body.writeUInt32LE(params.imgSize, 0);
    body.writeUInt32LE(params.imgCrc32 >>> 0, 4);
    body.writeUInt32LE(params.version >>> 0, 8);
    return this.send("begin", body);
  }

  /**
   * One chunk: `[offset_u32][len_u8][bytes…]`.
   *
   * Two host-side guards run first, each preventing a way to soft-brick the
   * device mid-session: a chunk larger than the bootloader accepts, and an
   * odd-length chunk anywhere but the end (B-17 / V-29 — the bootloader pads the
   * trailing half-word with 0xFF, and the next contiguous write collides on
   * that already-programmed cell with FLASH_SR_PGERR).
   */
  async data(params: FwuDataParams): Promise<CommandResponse & { info?: FwuDataInfo }> {
    const name = this.target.dataCommandName;
    if (params.bytes.length > FWU_MAX_CHUNK) {
      throw new Error(
        `${name} chunk too large: ${params.bytes.length} > ${FWU_MAX_CHUNK} (FWU_MAX_CHUNK)`
      );
    }
    if ((params.bytes.length & 1) === 1 && params.isFinal !== true) {
      throw new Error(
        `${name} non-final chunk must be even-length (got ${params.bytes.length}); ` +
          `set isFinal=true on the last chunk only`
      );
    }

    const body = Buffer.alloc(5 + params.bytes.length);
    body.writeUInt32LE(params.offset >>> 0, 0);
    body.writeUInt8(params.bytes.length, 4);
    params.bytes.copy(body, 5);

    const response = await this.send("data", body);
    if (response.data.length >= 4) {
      return { ...response, info: { nextExpectedOffset: response.data.readUInt32LE(0) } };
    }
    return response;
  }

  /** Verifies the CRC32 and stamps the application header. */
  end(): Promise<CommandResponse> {
    return this.send("end");
  }

  /** Tears the session down, leaving the header erased. */
  abort(): Promise<CommandResponse> {
    return this.send("abort");
  }

  /** Bootloader-side: reset into the application. */
  exit(): Promise<CommandResponse> {
    return this.send("exit");
  }
}
