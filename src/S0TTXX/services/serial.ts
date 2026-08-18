import { SerialPort } from "serialport";
import { debug } from "../../utils/debug";
import { BAUD_RATE } from "../../utils/constants";
import { Envelope, parseEnvelopeLine } from "../protocol/envelope";

/**
 * Serial transport for the S0TTXX cellular gateway's LOCAL connector
 * (firmware CONFIG_CLOUD_CONNECTOR_LOCAL, on USART1 @115200 8N1).
 *
 * The gateway speaks the exact Amperry cloud envelope over the wire — one
 * compact JSON object per line, "\n"-terminated, in BOTH directions (see
 * S0TTXX-firmware/docs/CLOUD_PROTOCOL.md §3). Downlink `cmd`/`cfg` we send are
 * handled by the SAME firmware path the MQTT broker will drive; uplinks
 * (`hello`/`hb`/`evt`/`tlm`/`resp`) arrive as lines we dispatch to listeners.
 *
 * Note: the app's own logs go over SEGGER RTT (SWD), not this UART, so the
 * command link is clean JSON — unlike the OEM 8N2 raw-frame link the old
 * S0RUXX module used.
 */
export class SerialService {
  private port: SerialPort | null = null;
  private rxBuffer: string = "";
  private listeners: Set<(env: Envelope) => void> = new Set();

  constructor(private portPath: string) {
    debug.info(`Initializing SerialService (S0TTXX) with port: ${portPath}`);
  }

  async connect(): Promise<void> {
    if (this.port?.isOpen) {
      debug.info("Port already connected");
      return;
    }
    debug.info(`Connecting to ${this.portPath} at ${BAUD_RATE} baud (8N1)`);

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: this.portPath,
        baudRate: BAUD_RATE,
        autoOpen: false,
        dataBits: 8,
        stopBits: 1, // firmware USART1 is 8N1 (dts current-speed, default 8N1)
        parity: "none",
      });

      this.port.open((err: any) => {
        if (err) {
          debug.error("Connection failed:", err);
          reject(err);
          return;
        }

        this.port!.on("data", (data: Buffer) => {
          this.rxBuffer += data.toString("ascii");
          this.drainLines();
        });

        this.port!.flush(() => {});
        this.rxBuffer = "";
        debug.success("Port connected successfully");
        resolve();
      });
    });
  }

  /** Split the RX buffer on newlines and dispatch each complete envelope. */
  private drainLines(): void {
    let nl: number;
    while ((nl = this.rxBuffer.indexOf("\n")) !== -1) {
      const line = this.rxBuffer.slice(0, nl).trim();
      this.rxBuffer = this.rxBuffer.slice(nl + 1);
      if (!line) continue;
      const env = parseEnvelopeLine(line);
      if (!env) {
        debug.log("Ignoring non-envelope line:", JSON.stringify(line));
        continue;
      }
      debug.log("RX envelope:", JSON.stringify(env));
      for (const cb of [...this.listeners]) {
        try {
          cb(env);
        } catch (e) {
          debug.error("listener threw:", e);
        }
      }
    }
  }

  async disconnect(): Promise<void> {
    this.listeners.clear();
    if (this.port) {
      return new Promise((resolve) => {
        this.port!.close(() => {
          this.port = null;
          this.rxBuffer = "";
          debug.log("Port disconnected");
          resolve();
        });
      });
    }
  }

  /** Send one envelope as a "\n"-terminated JSON line. */
  async sendEnvelope(env: Envelope): Promise<void> {
    if (!this.port?.isOpen) {
      throw new Error("Port not connected");
    }
    const line = JSON.stringify(env) + "\n";
    debug.log("TX envelope:", JSON.stringify(line));
    return new Promise((resolve, reject) => {
      this.port!.write(Buffer.from(line, "ascii"), (err: any) => {
        if (err) {
          reject(err);
          return;
        }
        this.port!.drain(() => resolve());
      });
    });
  }

  /** Register an envelope listener; returns an unsubscribe function. */
  onEnvelope(cb: (env: Envelope) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Wait up to `timeoutMs` for an envelope matching `predicate`. Resolves the
   * matching envelope, or null on timeout (no throw — the gateway may not reply,
   * e.g. an FB unlock has no main-board response, or no main board is attached).
   */
  async waitFor(
    predicate: (env: Envelope) => boolean,
    timeoutMs: number
  ): Promise<Envelope | null> {
    return new Promise((resolve) => {
      const unsubscribe = this.onEnvelope((env) => {
        if (predicate(env)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(env);
        }
      });
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(null);
      }, timeoutMs);
    });
  }
}
