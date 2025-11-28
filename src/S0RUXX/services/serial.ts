import { SerialPort } from "serialport";
import { debug } from "../../utils/debug";
import {
  BAUD_RATE,
  FRAME_START_CHAR,
  FRAME_END_CHAR,
} from "../protocol/constants";

export class SerialService {
  private port: SerialPort | null = null;
  private responseBuffer: string = "";
  private responseResolver: ((value: string) => void) | null = null;
  private responseRejector: ((error: Error) => void) | null = null;

  constructor(private portPath: string) {
    debug.info(`Initializing SerialService (S0RUXX) with port: ${portPath}`);
  }

  async connect(): Promise<void> {
    if (this.port?.isOpen) {
      debug.info("Port already connected");
      return;
    }

    debug.info(`Connecting to port: ${this.portPath} at ${BAUD_RATE} baud`);

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: this.portPath,
        baudRate: BAUD_RATE,
        autoOpen: false,
        dataBits: 8,
        stopBits: 2,
        parity: "none",
      });

      this.port.open((err: any) => {
        if (err) {
          debug.error("Connection failed:", err);
          reject(err);
          return;
        }

        // Setup data handler - this runs continuously
        this.port!.on("data", (data: Buffer) => {
          const text = data.toString("ascii");
          this.responseBuffer += text;
          debug.log("Received raw data:", JSON.stringify(text));
          debug.log("Current buffer:", JSON.stringify(this.responseBuffer));
          
          // Check if we have a complete frame and a resolver waiting
          if (this.responseResolver) {
            const frameStart = this.responseBuffer.indexOf(FRAME_START_CHAR);
            const frameEnd = this.responseBuffer.indexOf(FRAME_END_CHAR, frameStart);
            
            if (frameStart !== -1 && frameEnd !== -1) {
              const frame = this.responseBuffer.substring(frameStart, frameEnd + 1).trim();
              debug.log("Found complete frame:", JSON.stringify(frame));
              
              // Clear the frame from buffer
              this.responseBuffer = this.responseBuffer.substring(frameEnd + 1);
              
              // Resolve the promise
              const resolver = this.responseResolver;
              this.responseResolver = null;
              this.responseRejector = null;
              resolver(frame);
            }
          }
        });

        // Flush any existing data (non-critical if it fails)
        if (this.port) {
          this.port.flush((err: any) => {
            if (err) {
              debug.log("Initial flush error (non-critical):", err);
            }
          });
        }
        this.responseBuffer = "";
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
          this.responseBuffer = "";
          this.responseResolver = null;
          this.responseRejector = null;
          debug.log("Port disconnected");
          resolve();
        });
      });
    }
  }

  async sendCommand(command: string): Promise<string> {
    if (!this.port?.isOpen) {
      throw new Error("Port not connected");
    }

    return new Promise((resolve, reject) => {
      // Clear any previous resolver
      if (this.responseRejector) {
        this.responseRejector(new Error("New command sent, cancelling previous"));
      }

      // Set up timeout
      const timeout = setTimeout(() => {
        this.responseResolver = null;
        this.responseRejector = null;
        debug.error(`Response timeout. Buffer content: ${JSON.stringify(this.responseBuffer)}`);
        reject(new Error(`Response timeout. Received: ${JSON.stringify(this.responseBuffer)}`));
      }, 10000);

      // Set up response handlers
      this.responseResolver = (frame: string) => {
        clearTimeout(timeout);
        this.responseResolver = null;
        this.responseRejector = null;
        resolve(frame);
      };

      this.responseRejector = (error: Error) => {
        clearTimeout(timeout);
        this.responseResolver = null;
        this.responseRejector = null;
        reject(error);
      };

      // Send command with carriage return and newline (like Arduino IDE Serial Monitor)
      // Arduino IDE typically sends \r\n when you press Enter
      const frameWithCRLF = command + "\r\n";
      const frameBuffer = Buffer.from(frameWithCRLF, "ascii");

      debug.log(`Sending command: ${JSON.stringify(frameWithCRLF)}`);

      this.port!.write(frameBuffer, (err: any) => {
        if (err) {
          clearTimeout(timeout);
          this.responseResolver = null;
          this.responseRejector = null;
          reject(err);
          return;
        }

        debug.log("Command written, waiting for drain...");

        // Wait for drain to ensure data is sent
        this.port!.drain(() => {
          debug.log("Drain complete, waiting for response...");
          // Response will be handled by the data event handler
        });
      });
    });
  }

  async sendCommandNoResponse(command: string): Promise<void> {
    if (!this.port?.isOpen) {
      throw new Error("Port not connected");
    }

    // Send command with carriage return and newline (like Arduino IDE Serial Monitor)
    const frameWithCRLF = command + "\r\n";
    const frameBuffer = Buffer.from(frameWithCRLF, "ascii");

    debug.log(`Sending command (no response expected): ${JSON.stringify(frameWithCRLF)}`);

    return new Promise((resolve, reject) => {
      this.port!.write(frameBuffer, (err: any) => {
        if (err) {
          reject(err);
          return;
        }

        debug.log("Command written, waiting for drain...");

        // Wait for drain to ensure data is sent
        this.port!.drain(() => {
          debug.log("Drain complete, command sent successfully");
          resolve();
        });
      });
    });
  }

  async listPorts(): Promise<string[]> {
    const { SerialPort } = await import("serialport");
    return await SerialPort.list().then((ports: any[]) =>
      ports.map((port: any) => port.path)
    );
  }
}
