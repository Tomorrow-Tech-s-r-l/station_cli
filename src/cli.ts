#!/usr/bin/env node

import { Command } from "commander";
import packageJson from "../package.json";
import { logger } from "./utils/logger";
import { registerS1TTXXCommands } from "./S1TTXX/cli/cli";
import { registerS0RUXXCommands } from "./S0RUXX/cli/cli";

const program = new Command();

program
  .name(packageJson.name)
  .description(packageJson.description)
  .version(packageJson.version)
  .option("--log", "Enable logging to file (creates timestamp-cli-logs.log)")
  .hook("preAction", (thisCommand) => {
    const options = thisCommand.opts();
    if (options.log) {
      logger.enableFileLogging();
      logger.log(`Logging enabled. Log file: ${logger.getLogFilePath()}`);
    }
  });

// Handle graceful shutdown
process.on("exit", () => {
  if (logger.isLogging()) {
    logger.close();
  }
});

process.on("SIGINT", () => {
  if (logger.isLogging()) {
    logger.close();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (logger.isLogging()) {
    logger.close();
  }
  process.exit(0);
});

// Register commands from both device types
registerS1TTXXCommands(program);
registerS0RUXXCommands(program);

program.parse();
