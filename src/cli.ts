#!/usr/bin/env node

import { MAXIMUM_BOARD_ADDRESS, SLOT_LOCKED } from "./protocol/constants";
import {
  SlotServer,
  SlotState,
  SlotError,
  SlotErrorInfo,
  SlotsResponse,
} from "./protocol/types";
import { debug } from "./utils/debug";
import { selectPort } from "./utils/port_selector";
import { getStatusMessage } from "./utils/status";

const { Command } = require("commander");
const { SerialService } = require("./services/serial");
const { SlotsCommand } = require("./cli/commands/slots");
const { StatusCommand } = require("./cli/commands/status");
const { UnlockCommand } = require("./cli/commands/unlock");
const { ChargeCommand } = require("./cli/commands/charge");
const packageJson = require("../package.json");
const { CMD_GET_FW_VER, STATUS_ERR_INTERNAL } = require("./protocol/constants");
const {
  InitializePowerbankCommand,
} = require("./cli/commands/initialize_powerbank");

interface CommandOptions {
  port: string;
  board: string;
  slot: string;
  index: string;
  enable?: boolean;
}

const program = new Command();

program
  .name(packageJson.name)
  .description(packageJson.description)
  .version(packageJson.version);

// Get slots status
program
  .command("slots")
  .description("Get status of all slots")
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      const slots: SlotServer[] = [];
      const errors: SlotErrorInfo[] = [];
      let index = 1;

      const port = await selectPort();
      const service = new SerialService(port);
      await service.connect();

      const command = new SlotsCommand(service);
      const statusCommand = new StatusCommand(service);

      for (let i = 0; i <= MAXIMUM_BOARD_ADDRESS; i++) {
        const response = await command.execute(i);

        if (response.success) {
          try {
            const slotsInfo = JSON.parse(response.data.toString());
            debug.success("Slots status: ", slotsInfo);

            for (let j = 0; j < 6; j++) {
              const isAvailable = slotsInfo.filledSlots[j] == SLOT_LOCKED;
              let powerBankInfo = null;
              let powerLevel = 0;

              if (isAvailable) {
                try {
                  const statusResponse = await statusCommand.execute(i, j);
                  if (statusResponse.success) {
                    powerBankInfo = JSON.parse(statusResponse.data.toString());
                    const total = parseInt(powerBankInfo?.totalCharge) || 0;
                    const current = parseInt(powerBankInfo?.currentCharge) || 0;
                    powerLevel =
                      total > 0 ? Math.trunc((current / total) * 100) : 0;
                  } else {
                    errors.push({
                      boardAddress: i,
                      slotIndex: j,
                      error: SlotError.STATUS_COMMAND_FAILED,
                      message: getStatusMessage(statusResponse.status),
                    });
                  }
                } catch (error) {
                  errors.push({
                    boardAddress: i,
                    slotIndex: j,
                    error: SlotError.CONNECTION_ERROR,
                    message:
                      error instanceof Error ? error.message : "Unknown error",
                  });
                }
              }

              slots.push({
                powerBank: powerBankInfo
                  ? {
                      id: powerBankInfo?.serial,
                      powerLevel: powerLevel,
                    }
                  : null,
                isLocked: true,
                index: index++,
                state: isAvailable ? SlotState.available : SlotState.empty,
                disabled: false,
                boardAddress: i,
                slotIndex: j,
              });
            }
          } catch (error) {
            errors.push({
              boardAddress: i,
              slotIndex: -1,
              error: SlotError.INVALID_RESPONSE,
              message: "Failed to parse slots info response",
            });
          }
        } else {
          errors.push({
            boardAddress: i,
            slotIndex: -1,
            error: SlotError.STATUS_COMMAND_FAILED,
            message: getStatusMessage(response.status),
          });
        }
      }

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      const response: SlotsResponse = {
        slots,
        errors,
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString(),
      };

      console.log(JSON.stringify(response, null, 2));

      await service.disconnect();
    } catch (error) {
      console.error("Error:", error);
      process.exit(1);
    }
  });

// Unlock slot
program
  .command("unlock")
  .description("Unlock a slot")
  .requiredOption("-i, --index <index>", "Slot index (1-30)")
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      const port = await selectPort();
      const service = new SerialService(port);
      await service.connect();

      const command = new UnlockCommand(service);
      const response = await command.execute(parseInt(options.index));

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      const result = {
        success: response.success,
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString(),
        slotIndex: parseInt(options.index),
        boardAddress: Math.floor((parseInt(options.index) - 1) / 6),
        slotInBoard: (parseInt(options.index) - 1) % 6,
        error: response.success
          ? null
          : {
              code: response.status,
              message: getStatusMessage(response.status),
            },
      };

      console.log(JSON.stringify(result, null, 2));

      await service.disconnect();
    } catch (error) {
      const endTime = Date.now();
      const executionTime = endTime - startTime;

      const result = {
        success: false,
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString(),
        slotIndex: parseInt(options.index),
        boardAddress: Math.floor((parseInt(options.index) - 1) / 6),
        slotInBoard: (parseInt(options.index) - 1) % 6,
        error: {
          code: -1,
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };

      console.log(JSON.stringify(result, null, 2));
      process.exit(1);
    }
  });

// Enable/Disable charging
program
  .command("charge")
  .description("Enable or disable charging for a specific slot")
  .requiredOption("-i, --index <index>", "Slot index (1-30)")
  .requiredOption("-e, --enable <enable>", "Enable charging (true/false)")
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      const port = await selectPort();
      const service = new SerialService(port);
      await service.connect();

      const command = new ChargeCommand(service);
      const response = await command.execute(
        parseInt(options.index),
        options.enable
      );

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      const result = {
        success: response.success,
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString(),
        slotIndex: parseInt(options.index),
        boardAddress: Math.floor((parseInt(options.index) - 1) / 6),
        slotInBoard: (parseInt(options.index) - 1) % 6,
        chargingEnabled: !!options.enable,
        error: response.success
          ? null
          : {
              code: response.status,
              message: getStatusMessage(response.status),
            },
      };

      console.log(JSON.stringify(result, null, 2));

      await service.disconnect();
    } catch (error) {
      const endTime = Date.now();
      const executionTime = endTime - startTime;

      const result = {
        success: false,
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString(),
        slotIndex: parseInt(options.index),
        boardAddress: Math.floor((parseInt(options.index) - 1) / 6),
        slotInBoard: (parseInt(options.index) - 1) % 6,
        chargingEnabled: !!options.enable,
        error: {
          code: -1,
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };

      console.log(JSON.stringify(result, null, 2));
      process.exit(1);
    }
  });

/// DEBUG COMMANDS ///

// Status command used to get the status of a powerbank in a specific board and slot
program
  .command("status")
  .description("Get the status of a powerbank in a slot")
  .requiredOption("-b, --board <address>", "Board address (0-4)")
  .requiredOption("-s, --slot <index>", "Slot index (0-5)")
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      const port = await selectPort();
      const service = new SerialService(port);
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

// Get firmware version
program
  .command("firmware")
  .description("Get firmware version")
  .requiredOption("-b, --board <address>", "Board address (0-4)")
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      const port = await selectPort();
      const service = new SerialService(port);
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
  .requiredOption("-b, --board <address>", "Board address (0-4)")
  .requiredOption("-s, --slot <index>", "Slot index (0-5)")
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      /*TODO: Add system for creating serial number */
      const serialNumber = "0000000000"; // 10 characters
      const timestamp = Math.floor(Date.now() / 1000); // Convert to seconds
      const cycles = 1;

      const port = await selectPort();
      const service = new SerialService(port);
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
