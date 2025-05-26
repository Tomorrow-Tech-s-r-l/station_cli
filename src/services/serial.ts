import { SerialPort } from "serialport";
import { InterByteTimeoutParser } from "@serialport/parser-inter-byte-timeout";
import { debug } from "../utils/debug";
import { TransportProtocol } from "./transport";
import { CommandFactory } from "../protocol/commands";
import { SerialMessage } from "../protocol/types";
import { BAUD_RATE } from "../protocol/constants";

export class SerialService {
  private port: SerialPort | null = null;
  private parser: InterByteTimeoutParser | null = null;
  private responseResolver: ((value: Buffer) => void) | null = null;
  private readonly responseTimeout = 2000; // 2 second timeout
  private readonly FRAME_RECEIVE_DELAY_MS = 5; // 5ms delay after last byte
  private readonly INTER_BYTE_TIMEOUT_MS = 5; // 5ms inter-byte timeout
  private readonly MAX_RETRIES = 5; // Maximum number of retry attempts

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

      this.port.open((err) => {
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

        // Setup parser with 5ms inter-byte timeout (matching protocol)
        this.parser = this.port.pipe(
          new InterByteTimeoutParser({ interval: this.INTER_BYTE_TIMEOUT_MS })
        );

        // Flush any existing data
        this.port.flush();

        this.parser.on("data", (data: Buffer) => {
          debug.hex("Received raw data", data);
          if (this.responseResolver) {
            const payload = TransportProtocol.parseFrame(data);
            if (payload) {
              debug.success(
                "Successfully parsed response frame:",
                payload.toString("hex")
              );
              // Wait 5ms after last byte as per protocol
              setTimeout(() => {
                if (this.responseResolver) {
                  this.responseResolver(payload);
                }
              }, this.FRAME_RECEIVE_DELAY_MS);
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
      this.port!.flush((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Build command and frame
    const commandBuffer = CommandFactory.buildCommand(message);
    const frame = TransportProtocol.buildFrame(commandBuffer);
    debug.frame("TX", frame);

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

        // Accept response regardless of payload presence
        resolve(response);
      };

      this.port!.write(frame, (err) => {
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

  async sendMessage(message: SerialMessage): Promise<Buffer> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        debug.info(`Attempt ${attempt}/${this.MAX_RETRIES} to send message`);
        const response = await this.attemptSendMessage(message);
        if (attempt > 1) {
          debug.success(`Message sent successfully on attempt ${attempt}`);
        }
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        debug.error(
          `Attempt ${attempt}/${this.MAX_RETRIES} failed:`,
          lastError
        );

        if (attempt < this.MAX_RETRIES) {
          // Add a small delay between retries (100ms)
          await new Promise((resolve) => setTimeout(resolve, 100));
          debug.info(
            `Retrying message... (${attempt + 1}/${this.MAX_RETRIES})`
          );
        }
      }
    }

    // If we get here, all retries failed
    debug.error(
      `All ${this.MAX_RETRIES} attempts failed. Last error:`,
      lastError
    );
    throw lastError || new Error("Failed to send message after all retries");
  }

  async listPorts(): Promise<string[]> {
    const { SerialPort } = await import("serialport");
    return await SerialPort.list().then((ports) =>
      ports.map((port) => port.path)
    );
  }
}
