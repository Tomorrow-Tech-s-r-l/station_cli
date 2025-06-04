#!/usr/bin/env node

import {
  MAXIMUM_BOARD_ADDRESS,
  MAXIMUM_POWER_LEVEL,
  MAXIMUM_SLOT_ADDRESS,
  SLOT_INDEX_MAXIMUM,
  SLOT_INDEX_MINIMUM,
  SLOT_LOCKED,
} from "./protocol/constants";
import {
  SlotState,
  SlotError,
  SlotErrorInfo,
  SlotsResponse,
  SlotsInfo,
} from "./protocol/types";
import { debug } from "./utils/debug";
import { selectPort } from "./utils/port_selector";
import { getStatusMessage } from "./utils/status";
import { calculatePowerLevel } from "./utils/power_level";

import { Command } from "commander";
import { SerialService } from "./services/serial";
import { SlotsCommand } from "./cli/commands/slots";
import { StatusCommand } from "./cli/commands/status";
import { UnlockCommand } from "./cli/commands/unlock";
import { ChargeCommand } from "./cli/commands/charge";
import packageJson from "../package.json";
import { CMD_GET_FW_VER, STATUS_ERR_INTERNAL } from "./protocol/constants";
import { InitializePowerbankCommand } from "./cli/commands/initialize_powerbank";
import { mapBoardToSlot } from "./utils/slot_mapping";
import { LedCommand } from "./cli/commands/led";
import {
  cliInputValidatorEnable,
  cliInputValidatorIndex,
} from "./utils/cli_input_validator";

interface CommandOptions {
  port: string;
  board: string;
  slot: string;
  index: string;
  enable?: string;
  addresses?: string;
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
  .option(
    "-a, --addresses <addresses>",
    `Total addresses (0-${MAXIMUM_BOARD_ADDRESS})`
  )
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      const slots: SlotsInfo[] = [];
      const errors: SlotErrorInfo[] = [];

      const port = await selectPort();
      const service = new SerialService(port);
      await service.connect();

      const command = new SlotsCommand(service);
      const statusCommand = new StatusCommand(service);
      const ledCommand = new LedCommand(service);
      const chargeCommand = new ChargeCommand(service);

      const totalAddresses =
        options.addresses !== undefined
          ? parseInt(options.addresses)
          : MAXIMUM_BOARD_ADDRESS;

      for (let i = 0; i <= totalAddresses; i++) {
        const response = await command.execute(i);

        if (response.success) {
          try {
            const slotsInfo = JSON.parse(response.data.toString());
            debug.success("Slots status: ", slotsInfo);

            // Charging already enabled for all slots
            let chargingEnabled = false;

            for (let j = 0; j <= MAXIMUM_SLOT_ADDRESS; j++) {
              const isAvailable = slotsInfo.lockedSlots[j] == SLOT_LOCKED;
              let powerBankInfo = null;
              let powerLevel = 0;

              if (isAvailable) {
                // Turn on led for available slot
                await ledCommand.execute(mapBoardToSlot(i, j), true);

                // Get status of powerbank
                try {
                  const statusResponse = await statusCommand.execute(i, j);
                  if (statusResponse.success) {
                    powerBankInfo = JSON.parse(statusResponse.data.toString());
                    // Validate charge values
                    const currentCharge =
                      parseInt(powerBankInfo?.currentCharge) || 0;
                    const totalCharge =
                      parseInt(powerBankInfo?.totalCharge) || 0;

                    powerLevel = calculatePowerLevel(
                      currentCharge,
                      totalCharge
                    );

                    // Enable charging
                    if (powerLevel < MAXIMUM_POWER_LEVEL && !chargingEnabled) {
                      await chargeCommand.execute(mapBoardToSlot(i, j), true);
                      chargingEnabled = true;
                    } else {
                      await chargeCommand.execute(mapBoardToSlot(i, j), false);
                      chargingEnabled = false;
                    }
                  } else {
                    errors.push({
                      index: mapBoardToSlot(i, j),
                      boardAddress: i,
                      slotIndex: j,
                      error: SlotError.STATUS_COMMAND_FAILED,
                      message: getStatusMessage(statusResponse.status),
                    });
                  }
                } catch (error) {
                  errors.push({
                    index: mapBoardToSlot(i, j),
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
                isCharging: chargingEnabled,
                isLocked: true,
                index: mapBoardToSlot(i, j),
                //TODO: Momentarily we check if the powerBankInfo is null due to error on the return of command slotsInfo.lockedSlots[j]
                state:
                  powerBankInfo !== null
                    ? SlotState.available
                    : SlotState.empty,
                disabled: false,
                boardAddress: i,
                slotIndex: j,
              });
            }

            // Reset charging enabled
            chargingEnabled = false;
          } catch (error) {
            errors.push({
              index: -1,
              boardAddress: i,
              slotIndex: -1,
              error: SlotError.INVALID_RESPONSE,
              message:
                "Failed to parse slots info response: " +
                (error instanceof Error ? error.message : "Unknown error"),
            });
          }
        } else {
          errors.push({
            index: -1,
            boardAddress: i,
            slotIndex: -1,
            error: SlotError.SLOTS_COMMAND_FAILED,
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
  .requiredOption(
    "-i, --index <index>",
    `Slot index (${SLOT_INDEX_MINIMUM}-${SLOT_INDEX_MAXIMUM})`,
    cliInputValidatorIndex
  )
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

      if (response.success) {
        // Turn off led for unlocked slot
        const ledCommand = new LedCommand(service);
        await ledCommand.execute(parseInt(options.index), false);
      }

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
  .requiredOption(
    "-i, --index <index>",
    `Slot index (${SLOT_INDEX_MINIMUM}-${SLOT_INDEX_MAXIMUM})`,
    cliInputValidatorIndex
  )
  .requiredOption(
    "-e, --enable <enable>",
    "Enable charging (true/false)",
    cliInputValidatorEnable
  )
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      const port = await selectPort();
      const service = new SerialService(port);
      await service.connect();

      const command = new ChargeCommand(service);
      const response = await command.execute(
        parseInt(options.index),
        options.enable === "true" ? true : false
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
        chargingEnabled: options.enable === "true" ? true : false,
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

// Turn on/off led for a specific slot
program
  .command("led")
  .description("Turn on/off led for a specific slot")
  .requiredOption(
    "-i, --index <index>",
    `Slot index (${SLOT_INDEX_MINIMUM}-${SLOT_INDEX_MAXIMUM})`,
    cliInputValidatorIndex
  )
  .requiredOption(
    "-e, --enable <enable>",
    "Enable led (true/false)",
    cliInputValidatorEnable
  )
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      const port = await selectPort();
      const service = new SerialService(port);
      await service.connect();

      const command = new LedCommand(service);
      console.log(
        "Enable value:",
        options.enable,
        "Type:",
        typeof options.enable
      );
      const response = await command.execute(
        parseInt(options.index),
        options.enable === "true" ? true : false
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
        ledEnabled: !!options.enable,
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
      console.error("Error:", error);
      process.exit(1);
    }
  });

// Status command used to get the status of a powerbank in a specific board and slot
program
  .command("status")
  .description("Get the status of a powerbank in a slot")
  .requiredOption(
    "-b, --board <address>",
    `Board address (0-${MAXIMUM_BOARD_ADDRESS})`,
    (value) => {
      const board = parseInt(value);
      if (isNaN(board) || board < 0 || board > MAXIMUM_BOARD_ADDRESS) {
        throw new Error(
          `Board address must be between 0 and ${MAXIMUM_BOARD_ADDRESS}`
        );
      }
      return value;
    }
  )
  .requiredOption(
    "-s, --slot <address>",
    `Slot value (0-${MAXIMUM_SLOT_ADDRESS})`,
    (value) => {
      const slot = parseInt(value);
      if (isNaN(slot) || slot < 0 || slot > MAXIMUM_SLOT_ADDRESS) {
        throw new Error(
          `Slot address must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
        );
      }
      return value;
    }
  )
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
        const powerBankInfo = JSON.parse(response.data.toString());
        const powerLevel = calculatePowerLevel(
          powerBankInfo?.currentCharge,
          powerBankInfo?.totalCharge
        );

        const endTime = Date.now();
        const executionTime = endTime - startTime;

        const result = {
          success: response.success,
          executionTimeMs: executionTime,
          timestamp: new Date().toISOString(),
          ...powerBankInfo,
          powerLevel,
        };

        console.log(JSON.stringify(result, null, 2));
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
