import chalk from "chalk";

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
    }
  },
  error: (...args: any[]) => {
    if (DEBUG) {
      console.error(chalk.red("[DEBUG ERROR]"), ...args);
    }
  },
  warn: (...args: any[]) => {
    if (DEBUG) {
      console.warn(chalk.yellow("[DEBUG WARN]"), ...args);
    }
  },
  hex: (label: string, data: Buffer | number[]) => {
    if (DEBUG) {
      console.log(
        chalk.cyan("[DEBUG HEX]"),
        chalk.green(label + ":"),
        chalk.magenta(formatHex(data))
      );
    }
  },
  frame: (direction: "TX" | "RX", data: Buffer) => {
    if (DEBUG) {
      const color = direction === "TX" ? chalk.green : chalk.blue;
      console.log(
        color(`[DEBUG FRAME ${direction}]`),
        chalk.magenta(formatHex(data))
      );
    }
  },
  success: (...args: any[]) => {
    if (DEBUG) {
      console.log(chalk.green("[DEBUG SUCCESS]"), ...args);
    }
  },
  info: (...args: any[]) => {
    if (DEBUG) {
      console.log(chalk.cyan("[DEBUG INFO]"), ...args);
    }
  },
};
