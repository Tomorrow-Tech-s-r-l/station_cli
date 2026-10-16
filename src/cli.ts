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
  registerS0TTXXCommands,
  runS0TTXXSlots,
  runS0TTXXUnlock,
} from "./S0TTXX/cli/cli";
import {
  setModel,
  getModel,
  isS0TTModel,
  getSlotIndexMinimum,
  getSlotIndexMaximum,
} from "./utils/model";
import { cliInputValidatorIndex } from "./utils/cli_input_validator";
import { convertFrame } from "./S1TTXX/cli/commands/convert";
import { registerConfigCommands } from "./config/cli";
import { takeFlag } from "./utils/argv";
import { setPortOverride, pickPort } from "./utils/port_selector";
import { SerialPort } from "serialport";
import {
  extractModelFromArgv,
  addModelOption,
  programModelHelp,
  STATION_MODELS,
  S1TT_MODELS,
} from "./utils/model_cli";

// Resolve the station model (first-argument token or -m/--model) before any
// command is registered: option help and validators depend on its ranges.
// The serial port (-p/--port) is resolved the same way so every command that
// talks to the station honours it, not only the S0TTXX ones.
try {
  setModel(extractModelFromArgv(process.argv));
  const ports = takeFlag(process.argv, "-p", "--port", "a serial port (e.g. COM3, /dev/ttyUSB0)");
  setPortOverride(ports[ports.length - 1]);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const program = new Command();

program
  .name(packageJson.name)
  .description(packageJson.description)
  .version(packageJson.version)
  .usage("[model] [options] <command>")
  .addHelpText("after", programModelHelp())
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
registerS0TTXXCommands(program);
// Model-independent: inspects the layered configuration (src/config).
registerConfigCommands(program);

// Unified routed commands
interface RoutedOptions {
  index?: string;
  port?: string;
}

// Slots command
program
  .command("slots")
  .description("Get slots information")
  .action(async (options: RoutedOptions) => {
    if (isS0TTModel(getModel())) {
      await runS0TTXXSlots(options.port);
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
    const index = parseInt(options.index as string);
    if (isS0TTModel(getModel())) {
      await runS0TTXXUnlock(index, options.port);
    } else {
      await runS1TTXXUnlock(index);
    }
  });

// Ports command: what auto-detect sees, to find the station's COM port.
program
  .command("ports")
  .description("List serial ports and show which one auto-detect would use")
  .action(async () => {
    const ports = await SerialPort.list();
    const picked = pickPort(ports);
    logger.log(
      JSON.stringify(
        {
          autoDetected: picked ?? null,
          ports: ports.map((p) => ({
            path: p.path,
            manufacturer: p.manufacturer ?? null,
            vendorId: p.vendorId ?? null,
            productId: p.productId ?? null,
            pnpId: p.pnpId ?? null,
          })),
        },
        null,
        2
      )
    );
  });

// Convert command (available globally, works with S1TTXX protocol)
program
  .command("convert")
  .description("Convert hex frame to human-readable command information")
  .argument(
    "[hex...]",
    "Hex frame string (with or without spaces, e.g., 'ea 01 05 c0 23' or 'ea0105c023')"
  )
  .action((hexParts: string[]) => {
    // Join all arguments together (handles both quoted and unquoted input)
    const hex = hexParts.join(" ");
    convertFrame(hex);
  });

// Every station command takes -p/--port (consumed before parsing, above).
const PORT_OPTION_FLAGS = "-p, --port <port>";
const PORT_OPTION_HELP =
  'Serial port, e.g. COM3 or /dev/ttyUSB0 (default: STATION_CLI_PORT, else auto-detect; see "station-cli ports")';
for (const command of program.commands) {
  if (["slots", "unlock"].includes(command.name())) command.option(PORT_OPTION_FLAGS, PORT_OPTION_HELP);
}

// Model-dependent commands: document the model choice in their help.
const MODEL_DEPENDENT_COMMANDS: Record<string, typeof STATION_MODELS> = {
  slots: STATION_MODELS,
  unlock: STATION_MODELS,
  status: S1TT_MODELS,
  charge: S1TT_MODELS,
  "initialize-powerbank": S1TT_MODELS,
  firmware: S1TT_MODELS,
  "pb-firmware": S1TT_MODELS,
  "pb-link-stats": S1TT_MODELS,
  stats: S1TT_MODELS,
  "pb-enter-boot": S1TT_MODELS,
  "pb-fwu-hello": S1TT_MODELS,
  "pb-firmware-update": S1TT_MODELS,
  "pb-fwu-exit": S1TT_MODELS,
  "fwu-enter": S1TT_MODELS,
  "fwu-hello": S1TT_MODELS,
  "fwu-exit": S1TT_MODELS,
  "firmware-update": S1TT_MODELS,
  "fw-status": S1TT_MODELS,
  "fw-plan": S1TT_MODELS,
  "fw-apply": S1TT_MODELS,
};
for (const command of program.commands) {
  const models = MODEL_DEPENDENT_COMMANDS[command.name()];
  if (models) {
    addModelOption(command, models, getModel());
    if (!command.options.some((o) => o.long === "--port")) {
      command.option(PORT_OPTION_FLAGS, PORT_OPTION_HELP);
    }
  }
}

program.parse();
