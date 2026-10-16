import { SerialPort } from "serialport";
import { InterByteTimeoutParser } from "@serialport/parser-inter-byte-timeout";
import { debug } from "../../utils/debug";
import { TransportProtocol } from "./transport";
import { CommandFactory } from "../protocol/commands";
import { SerialMessage } from "../protocol/types";
import { BAUD_RATE, INTER_COMMAND_DELAY_MS } from "../../utils/constants";
import { hex, rawTrace } from "../../utils/test_modes";

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

  async listPorts(): Promise<string[]> {
    const { SerialPort } = await import("serialport");
    return await SerialPort.list().then((ports: any[]) =>
      ports.map((port: any) => port.path)
    );
  }
}
