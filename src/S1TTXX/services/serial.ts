import { SerialPort } from "serialport";
import { InterByteTimeoutParser } from "@serialport/parser-inter-byte-timeout";
import { debug } from "../../utils/debug";
import { TransportProtocol } from "./transport";
import { CommandFactory } from "../protocol/commands";
import { SerialMessage } from "../protocol/types";
import { BAUD_RATE, INTER_COMMAND_DELAY_MS, CMD_PB_LINK_ATTEMPTS } from "../../utils/constants";
import { hex, isNoRetryMode, rawTrace, testNotice } from "../../utils/test_modes";

// Opcodes the station forwards to a docked powerbank over the pogo link —
// the ones its own link retries apply to (see --no-retry).
const POWERBANK_ROUTED_COMMANDS = new Set([
  0x01, 0x02, 0x03, 0x04, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16,
]);

// Boards whose station retries --no-retry turned off and that were not
// restored yet, across every SerialService in the process (checked on exit).
const boardsLeftWithoutRetries = new Set<number>();
process.on("exit", () => {
  for (const board of boardsLeftWithoutRetries) {
    testNotice(
      `board ${board} is still at 1 powerbank-link attempt (the command ended before it was restored). ` +
        `Restore it with "station-cli pb-link-attempts -b ${board} --reset" or power-cycle the station.`
    );
  }
});

export class SerialService {
  private port: SerialPort | null = null;
  private parser: InterByteTimeoutParser | null = null;
  private responseResolver: ((value: Buffer) => void) | null = null;
  private readonly responseTimeout = 5000; // 5 second timeout
  private readonly INTER_BYTE_TIMEOUT_MS = 50; // 5ms inter-byte timeout
  private sentAt = 0;
  // Set while sending a --raw bookkeeping request (station trace pages), so
  // those frames do not clutter the trace they are fetching.
  private quiet = false;
  // --no-retry: station link attempts per board before we lowered them
  // (null = firmware without HOST_CMD_PB_LINK_ATTEMPTS).
  private readonly savedLinkAttempts = new Map<number, number | null>();

  constructor(private portPath: string) {
    debug.info(`Initializing SerialService with port: ${portPath}`);
  }

  async connect(): Promise<void> {
    if (this.port) {
      debug.info("Port already connected");
      return;
    }

    debug.info(`Connecting to port: ${this.portPath} at ${BAUD_RATE} baud`);
    this.port = new SerialPort({
      path: this.portPath,
      baudRate: BAUD_RATE,
      autoOpen: false,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
    });

    return new Promise((resolve, reject) => {
      if (!this.port) {
        const error = new Error("Port not initialized");
        debug.error("Connection failed:", error);
        reject(error);
        return;
      }

      this.port.open((err: any) => {
        if (err) {
          debug.error("Connection failed:", err);
          reject(err);
          return;
        }

        if (!this.port) {
          const error = new Error("Port not initialized after open");
          debug.error("Connection failed:", error);
          reject(error);
          return;
        }

        // Setup parser with inter-byte timeout (matching protocol)
        this.parser = this.port.pipe(
          new InterByteTimeoutParser({ interval: this.INTER_BYTE_TIMEOUT_MS })
        );

        // Flush any existing data
        this.port.flush();

        this.parser.on("data", (data: Buffer) => {
          debug.hex("Received raw data", data);
          if (!this.quiet) rawTrace("RX frame", `${hex(data)}  (${Math.round(performance.now() - this.sentAt)}ms after TX)`);
          if (this.responseResolver) {
            const payload = TransportProtocol.parseFrame(data);
            if (payload) {
              debug.success(
                "Successfully parsed response frame:",
                payload.toString("hex")
              );
              this.responseResolver(payload);
            } else {
              debug.error("Failed to parse frame");
            }
          }
        });

        debug.success("Port connected successfully");
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    await this.restoreLinkAttempts();
    if (this.port) {
      return new Promise((resolve) => {
        this.port!.close(() => {
          this.port = null;
          this.parser = null;
          debug.log("Port disconnected");
          resolve();
        });
      });
    }
  }

  private async attemptSendMessage(message: SerialMessage): Promise<Buffer> {
    if (!this.port || !this.parser) {
      const error = new Error("Port not connected");
      debug.error("Send message failed:", error);
      throw error;
    }

    debug.info("Sending message:", {
      boardAddress: message.boardAddress,
      command: message.command,
      dataLength: message.data?.length || 0,
    });

    // Flush any existing data before sending
    await new Promise<void>((resolve, reject) => {
      this.port!.flush((err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Build command and frame
    const commandBuffer = CommandFactory.buildCommand(message);
    debug.payload("Command Buffer", commandBuffer);

    const frame = TransportProtocol.buildFrame(commandBuffer);
    debug.frame("TX", frame);
    if (!this.quiet) rawTrace(
      "TX",
      `board=${message.boardAddress} cmd=0x${message.command.toString(16).padStart(2, "0")} ` +
        `payload=[${hex(commandBuffer)}] frame=[${hex(frame)}]`
    );
    this.sentAt = performance.now();

    return await new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.responseResolver = null;
      };

      timeoutId = setTimeout(() => {
        cleanup();
        const error = new Error("Request timeout - no response received");
        debug.error("Send message failed:", error);
        if (!this.quiet) rawTrace("TIMEOUT", `no reply after ${this.responseTimeout}ms`);
        reject(error);
      }, this.responseTimeout);

      this.responseResolver = (response: Buffer) => {
        cleanup();
        // Verify response format: <msgType> <status> [<payload>]
        if (response.length < 2) {
          reject(new Error("Invalid response format: too short"));
          return;
        }
        const msgType = response[0];
        const status = response[1];
        const payload =
          response.length > 2 ? response.subarray(2) : Buffer.alloc(0);

        debug.response("Full Response", response, status);
        if (payload.length > 0) {
          debug.hex("Response Payload", payload);
        }
        // Frame body is [board][cmd][status][data...].
        if (response.length >= 3 && !this.quiet) {
          rawTrace(
            "RX",
            `board=${response[0]} cmd=0x${response[1].toString(16).padStart(2, "0")} ` +
              `status=${response[2]} data=[${hex(response.subarray(3))}] (${response.length - 3} bytes)`
          );
        }

        // Accept response regardless of payload presence
        resolve(response);
      };

      this.port!.write(frame, (err: any) => {
        if (err) {
          cleanup();
          debug.error("Write failed:", err);
          reject(err);
          return;
        }
        debug.success("Frame written successfully");
      });
    });
  }

  async sendMessage(message: SerialMessage, options: { quiet?: boolean } = {}): Promise<Buffer> {
    if (isNoRetryMode() && POWERBANK_ROUTED_COMMANDS.has(message.command)) {
      await this.disableLinkRetries(message.boardAddress);
    }
    this.quiet = options.quiet === true;
    let response: Buffer;
    try {
      response = await this.attemptSendMessage(message);
    } finally {
      this.quiet = false;
    }
    // Add delay between commands for USB serial stability
    await new Promise((resolve) => setTimeout(resolve, INTER_COMMAND_DELAY_MS));
    return response;
  }

  /**
   * HOST_CMD_PB_LINK_ATTEMPTS: read (set = 0) or set the station's attempts
   * per powerbank transaction. Returns [attempts, default], or null when the
   * firmware is not a test build (it answers ERR_INVALID_TYPE).
   */
  async linkAttempts(boardAddress: number, set: number): Promise<[number, number] | null> {
    const r = await this.sendMessage(
      { boardAddress, command: CMD_PB_LINK_ATTEMPTS, data: Buffer.from([set]) },
      { quiet: true }
    );
    if (r.length < 5 || r[2] !== 0) return null;
    return [r[3], r[4]];
  }

  /** --no-retry: lower a board's station retries to 1, once per board. */
  private async disableLinkRetries(boardAddress: number): Promise<void> {
    if (this.savedLinkAttempts.has(boardAddress)) return;
    this.savedLinkAttempts.set(boardAddress, null); // set first: linkAttempts re-enters sendMessage
    let saved: number | null = null;
    try {
      const before = await this.linkAttempts(boardAddress, 0);
      if (before !== null && (await this.linkAttempts(boardAddress, 1)) !== null) {
        saved = before[0];
      }
    } catch {
      saved = null;
    }
    this.savedLinkAttempts.set(boardAddress, saved);
    if (saved === null) {
      testNotice(
        `board ${boardAddress}: this station firmware cannot turn off its own powerbank-link retries ` +
          `(it lacks host opcode 0x54, pb-link-attempts); only the CLI retries are off`
      );
    } else {
      boardsLeftWithoutRetries.add(boardAddress);
      testNotice(`board ${boardAddress}: station powerbank-link retries off (was ${saved} attempts, now 1)`);
    }
  }

  /** Put back what disableLinkRetries changed. */
  private async restoreLinkAttempts(): Promise<void> {
    for (const [board, saved] of this.savedLinkAttempts) {
      if (saved === null || !this.port) continue;
      try {
        if ((await this.linkAttempts(board, saved)) !== null) {
          boardsLeftWithoutRetries.delete(board);
          testNotice(`board ${board}: station powerbank-link attempts restored to ${saved}`);
        }
      } catch {
        // Reported by the exit hook.
      }
    }
    this.savedLinkAttempts.clear();
  }

  async listPorts(): Promise<string[]> {
    const { SerialPort } = await import("serialport");
    return await SerialPort.list().then((ports: any[]) =>
      ports.map((port: any) => port.path)
    );
  }
}
