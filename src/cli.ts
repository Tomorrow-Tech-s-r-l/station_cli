#!/usr/bin/env node

import { Command } from "commander";
import { SerialService } from "./services/serial";
import { SlotsCommand } from "./cli/commands/slots";
import { StatusCommand } from "./cli/commands/status";
import {
  CMD_GET_FW_VER,
  STATUS_OK,
  STATUS_TIMEOUT,
  STATUS_ERR_INVALID_CMD,
  STATUS_ERR_INVALID_ARGS,
  STATUS_ERR_INTERNAL,
  STATUS_ERR_INVALID_RESPONSE,
} from "./protocol/constants";
import { InitializePowerbankCommand } from "./cli/commands/initialize_powerbank";

const program = new Command();

program
  .name("station-cli")
  .description("CLI tool to control station board and powerbanks")
  .version("1.0.0");

const getStatusMessage = (status: number): string => {
  switch (status) {
    case STATUS_OK:
      return "Command successful";
    case STATUS_TIMEOUT:
      return "Device timeout - device not responding";
    case STATUS_ERR_INVALID_CMD:
      return "Invalid command - command not supported";
    case STATUS_ERR_INVALID_ARGS:
      return "Invalid arguments - check command parameters";
    case STATUS_ERR_INTERNAL:
      return "Internal device error - device may need reset";
    case STATUS_ERR_INVALID_RESPONSE:
      return "Invalid response format from device";
    default:
      return `Unknown error (code: ${status})`;
  }
};

// List available ports
program
  .command("list-ports")
  .description("List available serial ports")
  .action(async () => {
    const service = new SerialService("");
    const ports = await service.listPorts();
    console.log("Available ports:");
    ports.forEach((port) => console.log(`- ${port}`));
  });

// Status command
program
  .command("status")
  .description("Get the status of a powerbank in a slot")
  .requiredOption("-p, --port <path>", "Serial port path")
  .requiredOption("-b, --board <address>", "Board address (0-4)")
  .requiredOption("-s, --slot <index>", "Slot index (0-5)")
  .action(async (options) => {
    try {
      const service = new SerialService(options.port);
      await service.connect();

      const command = new StatusCommand(service);
      const response = await command.execute(
        parseInt(options.board),
        parseInt(options.slot)
      );

      if (response.success) {
        console.log("Powerbank info:", JSON.parse(response.data.toString()));
      } else {
        console.error("Command failed:", getStatusMessage(response.status));
        if (response.status === STATUS_ERR_INTERNAL) {
          console.error("\nPossible solutions:");
          console.error("1. Try resetting the device");
          console.error("2. Check if the powerbank is properly inserted");
          console.error("3. Try a different slot");
        }
      }

      await service.disconnect();
    } catch (error) {
      console.error("Error:", error);
      process.exit(1);
    }
  });

// Get slots status
program
  .command("slots")
  .description("Get status of all slots")
  .requiredOption("-p, --port <path>", "Serial port path")
  .requiredOption("-b, --board <address>", "Board address (0-4)")
  .action(async (options) => {
    try {
      const service = new SerialService(options.port);
      await service.connect();

      const command = new SlotsCommand(service);
      const response = await command.execute(parseInt(options.board));

      if (response.success) {
        const slotsInfo = JSON.parse(response.data.toString());
        console.log("Slots status:");
        console.log("Filled slots:", slotsInfo.filledSlots);
        console.log("Locked slots:", slotsInfo.lockedSlots);
      } else {
        console.error("Command failed:", getStatusMessage(response.status));
      }

      await service.disconnect();
    } catch (error) {
      console.error("Error:", error);
      process.exit(1);
    }
  });

// Get firmware version
program
  .command("firmware")
  .description("Get firmware version")
  .requiredOption("-p, --port <path>", "Serial port path")
  .requiredOption("-b, --board <address>", "Board address (0-4)")
  .action(async (options) => {
    try {
      const service = new SerialService(options.port);
      await service.connect();

      const response = await service.sendMessage({
        boardAddress: parseInt(options.board),
        command: CMD_GET_FW_VER,
      });

      if (response[1] === 0 && response.length >= 4) {
        console.log(
          "Firmware version:",
          `${response[2]}.${response[3]}.${response[4]}`
        );
      } else {
        console.error("Command failed with status:", response[1]);
      }

      await service.disconnect();
    } catch (error) {
      console.error("Error:", error);
      process.exit(1);
    }
  });

// Initialize powerbank
program
  .command("initialize-powerbank")
  .description("Initialize a powerbank")
  .requiredOption("-p, --port <path>", "Serial port path")
  .requiredOption("-b, --board <address>", "Board address (0-4)")
  .requiredOption("-s, --slot <index>", "Slot index (0-5)")
  .action(async (options) => {
    try {
      /*TODO: Add system for creating serial number */
      const serialNumber = "0000000000"; // 10 characters
      const timestamp = Math.floor(Date.now() / 1000); // Convert to seconds
      const cycles = 1;

      const service = new SerialService(options.port);
      await service.connect();

      const command = new InitializePowerbankCommand(service);
      const response = await command.execute(
        parseInt(options.board),
        parseInt(options.slot),
        {
          serialNumber,
          timestamp,
          cycles,
        }
      );

      if (response.success) {
        console.log("Powerbank initialized");
      } else {
        console.error("Command failed:", getStatusMessage(response.status));
      }

      await service.disconnect();
    } catch (error) {
      console.error("Error:", error);
      process.exit(1);
    }
  });

program.parse();
