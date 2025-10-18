import chalk from "chalk";
import { logger } from "./logger";

const DEBUG = process.env.DEBUG === "true";

const formatHex = (data: Buffer | number[]): string => {
  if (Buffer.isBuffer(data)) {
    return data.toString("hex").match(/.{2}/g)?.join(" ") || "";
  }
  return Buffer.from(data).toString("hex").match(/.{2}/g)?.join(" ") || "";
};

export const debug = {
  log: (...args: any[]) => {
    if (DEBUG) {
      console.log(chalk.blue("[DEBUG]"), ...args);
      if (logger.isLogging()) {
        logger.log("[DEBUG]", ...args);
      }
    }
  },
  error: (...args: any[]) => {
    if (DEBUG) {
      console.error(chalk.red("[DEBUG ERROR]"), ...args);
      if (logger.isLogging()) {
        logger.error("[DEBUG ERROR]", ...args);
      }
    }
  },
  warn: (...args: any[]) => {
    if (DEBUG) {
      console.warn(chalk.yellow("[DEBUG WARN]"), ...args);
      if (logger.isLogging()) {
        logger.log("[DEBUG WARN]", ...args);
      }
    }
  },
  hex: (label: string, data: Buffer | number[]) => {
    if (DEBUG) {
      console.log(
        chalk.cyan("[DEBUG HEX]"),
        chalk.green(label + ":"),
        chalk.magenta(formatHex(data))
      );
      if (logger.isLogging()) {
        logger.log("[DEBUG HEX]", label + ":", formatHex(data));
      }
    }
  },
  frame: (direction: "TX" | "RX", data: Buffer) => {
    if (DEBUG) {
      const color = direction === "TX" ? chalk.green : chalk.blue;
      console.log(
        color(`[DEBUG FRAME ${direction}]`),
        chalk.magenta(formatHex(data))
      );
      if (logger.isLogging()) {
        logger.log(`[DEBUG FRAME ${direction}]`, formatHex(data));
      }
    }
  },
  success: (...args: any[]) => {
    if (DEBUG) {
      console.log(chalk.green("[DEBUG SUCCESS]"), ...args);
      if (logger.isLogging()) {
        logger.log("[DEBUG SUCCESS]", ...args);
      }
    }
  },
  info: (...args: any[]) => {
    if (DEBUG) {
      console.log(chalk.cyan("[DEBUG INFO]"), ...args);
      if (logger.isLogging()) {
        logger.log("[DEBUG INFO]", ...args);
      }
    }
  },
  slotRequest: (
    commandName: string,
    boardAddress: number,
    slotIndex?: number
  ) => {
    if (DEBUG) {
      const separator = "=".repeat(80);
      const slotInfo = slotIndex !== undefined ? ` Slot ${slotIndex}` : "";
      const message = `${commandName} - Board ${boardAddress}${slotInfo}`;
      console.log(chalk.magenta.bold(`\n${separator}`));
      console.log(chalk.magenta.bold(`[SLOT REQUEST START] ${message}`));
      console.log(chalk.magenta.bold(separator));
      if (logger.isLogging()) {
        logger.log(`\n${separator}`);
        logger.log(`[SLOT REQUEST START] ${message}`);
        logger.log(separator);
      }
    }
  },
  payload: (label: string, data: Buffer) => {
    if (DEBUG) {
      console.log(
        chalk.yellow.bold(`[PAYLOAD ${label}]`),
        chalk.magenta(formatHex(data))
      );
      if (logger.isLogging()) {
        logger.log(`[PAYLOAD ${label}]`, formatHex(data));
      }
    }
  },
  response: (label: string, data: Buffer, status: number) => {
    if (DEBUG) {
      const statusColor = status === 0 ? chalk.green : chalk.red;
      console.log(
        chalk.cyan.bold(`[RESPONSE ${label}]`),
        "Status:",
        statusColor(status),
        "Data:",
        chalk.magenta(formatHex(data))
      );
      if (logger.isLogging()) {
        logger.log(
          `[RESPONSE ${label}] Status: ${status} Data: ${formatHex(data)}`
        );
      }
    }
  },
  slotRequestEnd: () => {
    if (DEBUG) {
      const separator = "=".repeat(80);
      console.log(chalk.magenta.bold(`[SLOT REQUEST END] ${separator}\n`));
      if (logger.isLogging()) {
        logger.log(`[SLOT REQUEST END] ${separator}\n`);
      }
    }
  },
};
