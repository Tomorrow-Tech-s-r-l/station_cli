#!/usr/bin/env node

import { Command } from "commander";
import packageJson from "../package.json";
import { logger } from "./utils/logger";
import {
  registerS1TTXXCommands,
  runS1TTXXSlots,
  runS1TTXXUnlock,
} from "./S1TTXX/cli/cli";
import {
  registerS0RUXXCommands,
  runS0RUXXSlots,
  runS0RUXXUnlock,
} from "./S0RUXX/cli/cli";
import {
  setModel,
  getModel,
  type StationModel,
  getSlotIndexMinimum,
  getSlotIndexMaximum,
} from "./utils/model";
import { cliInputValidatorIndex } from "./utils/cli_input_validator";

// Parse optional positional mode token before any command.
// Accepted: S1TT30 (default), S1TT6, S0RU6
(() => {
  const token = process.argv[2];
  const allowed: StationModel[] = ["S1TT30", "S1TT6", "S0RU6"];
  if (allowed.includes(token as StationModel)) {
    setModel(token as StationModel);
    // Remove the token so Commander sees the command next
    process.argv.splice(2, 1);
  } else {
    // Default for backward compatibility
    setModel("S1TT30");
  }
})();

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
      logger.log(`Model: ${getModel()}`);
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

// Unified routed commands
interface RoutedOptions {
  index?: string;
}

// Slots command
program
  .command("slots")
  .description("Get slots information")
  .action(async (options: RoutedOptions) => {
    const model = getModel();
    if (model === "S0RU6") {
      await runS0RUXXSlots();
    } else {
      await runS1TTXXSlots();
    }
  });

// Unlock command
program
  .command("unlock")
  .description("Unlock a slot")
  .requiredOption(
    "-i, --index <index>",
    `Slot index (${getSlotIndexMinimum()}-${getSlotIndexMaximum()})`,
    cliInputValidatorIndex
  )
  .action(async (options: RoutedOptions) => {
    const model = getModel();
    const index = parseInt(options.index as string);
    if (model === "S0RU6") {
      await runS0RUXXUnlock(index);
    } else {
      await runS1TTXXUnlock(index);
    }
  });

program.parse();
