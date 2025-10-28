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
import { logger } from "./utils/logger";

import { Command } from "commander";
import { SerialService } from "./services/serial";
import { SlotsCommand } from "./cli/commands/slots";
import { StatusCommand } from "./cli/commands/status";
import { UnlockCommand } from "./cli/commands/unlock";
import { ChargeCommand } from "./cli/commands/charge";
import packageJson from "../package.json";
import {
  CMD_GET_FW_VER,
  CMD_MODEL,
  STATUS_ERR_INTERNAL,
} from "./protocol/constants";
import { InitializePowerbankCommand } from "./cli/commands/initialize_powerbank";
import {
  mapBoardToSlot,
  mapSlotToBoard,
  SLOT_IS_DISABLED_DEFAULT_VALUE,
  SLOT_IS_LOCKED_DEFAULT_VALUE,
} from "./utils/slot_mapping";
import { LedCommand } from "./cli/commands/led";
import { ModelCommand } from "./cli/commands/model";
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
  id?: string;
  totalCharge?: string;
  currentCharge?: string;
  cutoffCharge?: string;
  cycles?: string;
}

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
        try {
          const response = await command.execute(i);

          if (response.success) {
            try {
              const slotsInfo = JSON.parse(response.data.toString());
              debug.success("Slots status: ", slotsInfo);

              // Phase 1: Collect slot information for this board
              const boardSlots: Array<{
                slotIndex: number;
                isAvailable: boolean;
                powerBankInfo: any;
                powerLevel: number;
                needsCharging: boolean;
              }> = [];

              for (let j = 0; j <= MAXIMUM_SLOT_ADDRESS; j++) {
                const isAvailable = slotsInfo.lockedSlots[j] == SLOT_LOCKED;
                let powerBankInfo = null;
                let powerLevel = 0;
                let needsCharging = false;

                // Turn on led for available slot
                await ledCommand.execute(mapBoardToSlot(i, j), isAvailable);

                if (isAvailable) {
                  // Get status of powerbank
                  try {
                    const statusResponse = await statusCommand.execute(i, j);
                    if (statusResponse.success) {
                      powerBankInfo = JSON.parse(
                        statusResponse.data.toString()
                      );
                      const currentCharge =
                        parseInt(powerBankInfo?.currentCharge) || 0;
                      const totalCharge =
                        parseInt(powerBankInfo?.totalCharge) || 0;

                      powerLevel = calculatePowerLevel(
                        currentCharge,
                        totalCharge
                      );

                      needsCharging = powerLevel < MAXIMUM_POWER_LEVEL;
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
                        error instanceof Error
                          ? error.message
                          : "Unknown error",
                    });
                  }
                }

                boardSlots.push({
                  slotIndex: j,
                  isAvailable,
                  powerBankInfo,
                  powerLevel,
                  needsCharging,
                });
              }

              // Phase 2: Determine which slot (if any) should charge
              // Rule: Only ONE powerbank per board can charge at a time
              let chargingSlotIndex = -1;
              for (const slot of boardSlots) {
                if (slot.needsCharging) {
                  chargingSlotIndex = slot.slotIndex;
                  break; // Select first powerbank that needs charging
                }
              }

              // Phase 3: Apply charging commands and build response
              for (const slot of boardSlots) {
                const shouldCharge = slot.slotIndex === chargingSlotIndex;

                // Send charge command for available slots
                if (slot.isAvailable) {
                  await chargeCommand.execute(
                    mapBoardToSlot(i, slot.slotIndex),
                    shouldCharge
                  );
                }

                slots.push({
                  powerBank: slot.powerBankInfo
                    ? {
                        id: slot.powerBankInfo?.serial,
                        powerLevel: slot.powerLevel,
                      }
                    : null,
                  isCharging: shouldCharge,
                  isLocked: SLOT_IS_LOCKED_DEFAULT_VALUE,
                  index: mapBoardToSlot(i, slot.slotIndex),
                  state:
                    slot.powerBankInfo !== null
                      ? SlotState.available
                      : SlotState.empty,
                  disabled: SLOT_IS_DISABLED_DEFAULT_VALUE,
                  boardAddress: i,
                  slotIndex: slot.slotIndex,
                });
              }
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
        } catch (error) {
          // Handle timeout or connection errors for this board
          // Log the error and continue to the next board
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          errors.push({
            index: -1,
            boardAddress: i,
            slotIndex: -1,
            error: SlotError.CONNECTION_ERROR,
            message: `Board ${i} not responding: ${errorMessage}`,
          });
          logger.error(`Error communicating with board ${i}: ${errorMessage}`);
          // Continue to next board
          continue;
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

      logger.log(JSON.stringify(response, null, 2));

      await service.disconnect();
    } catch (error) {
      logger.error("Error:", error);
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

      logger.log(JSON.stringify(result, null, 2));

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

      logger.log(JSON.stringify(result, null, 2));
      process.exit(1);
    }
  });

// Status command used to get the status of a powerbank in a specific board and slot
program
  .command("status")
  .description("Get the status of a powerbank in a specific index")
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

      const command = new StatusCommand(service);
      const slotsCommand = new SlotsCommand(service);
      const slotMapping = mapSlotToBoard(parseInt(options.index));
      // Check occupancy using SlotsCommand
      let isAvailable: boolean;

      const slotsResp = await slotsCommand.execute(slotMapping.boardAddress);

      if (slotsResp.success) {
        const slotsInfo = JSON.parse(slotsResp.data.toString());
        isAvailable =
          slotsInfo.lockedSlots[slotMapping.slotInBoard] == SLOT_LOCKED;
      } else {
        let error = {
          index: parseInt(options.index),
          boardAddress: slotMapping.boardAddress,
          slotIndex: slotMapping.slotInBoard,
          error: SlotError.SLOTS_COMMAND_FAILED,
          message: getStatusMessage(slotsResp.status),
        };
        logger.log(JSON.stringify(error, null, 2));
        await service.disconnect();
        process.exit(1);
      }

      // If slot is empty, return early with a clear response
      if (!isAvailable) {
        const endTime = Date.now();
        const executionTime = endTime - startTime;
        const result = {
          success: true,
          executionTimeMs: executionTime,
          timestamp: new Date().toISOString(),
          slot: {
            powerBank: null,
            isCharging: false,
            isLocked: SLOT_IS_LOCKED_DEFAULT_VALUE,
            index: parseInt(options.index),
            state: SlotState.empty,
            disabled: SLOT_IS_DISABLED_DEFAULT_VALUE,
            boardAddress: slotMapping.boardAddress,
            slotIndex: slotMapping.slotInBoard,
          },
        };
        logger.log(JSON.stringify(result, null, 2));
        await service.disconnect();
      } else {
        const response = await command.execute(
          slotMapping.boardAddress,
          slotMapping.slotInBoard
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
            slot: {
              powerBank: {
                id: powerBankInfo?.serial,
                powerLevel: powerLevel,
              },
              isCharging: powerBankInfo?.isCharging,
              isLocked: SLOT_IS_LOCKED_DEFAULT_VALUE,
              index: parseInt(options.index),
              state: SlotState.available,
              disabled: SLOT_IS_DISABLED_DEFAULT_VALUE,
              boardAddress: slotMapping.boardAddress,
              slotIndex: slotMapping.slotInBoard,
            },
          };

          logger.log(JSON.stringify(result, null, 2));
        } else {
          const endTime = Date.now();
          const executionTime = endTime - startTime;

          const result = {
            success: false,
            executionTimeMs: executionTime,
            timestamp: new Date().toISOString(),
            slotIndex: parseInt(options.index),
            boardAddress: slotMapping.boardAddress,
            slotInBoard: slotMapping.slotInBoard,
            isEmpty: !isAvailable,
            error: {
              code: response.status,
              message: getStatusMessage(response.status),
            },
          };

          logger.log(JSON.stringify(result, null, 2));
          if (response.status === STATUS_ERR_INTERNAL) {
            logger.error("\nPossible solutions:");
            logger.error("1. Try resetting the device");
            logger.error("2. Check if the powerbank is properly inserted");
            logger.error("3. Try a different slot");
          }
        }

        await service.disconnect();
      }
    } catch (error) {
      const endTime = Date.now();
      const executionTime = endTime - startTime;

      const slotMapping = mapSlotToBoard(parseInt(options.index));
      const result = {
        success: false,
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString(),
        slotIndex: parseInt(options.index),
        boardAddress: slotMapping.boardAddress,
        slotInBoard: slotMapping.slotInBoard,
        error: {
          code: -1,
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };

      logger.log(JSON.stringify(result, null, 2));
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

      logger.log(JSON.stringify(result, null, 2));

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

      logger.log(JSON.stringify(result, null, 2));
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

      logger.log(JSON.stringify(result, null, 2));

      await service.disconnect();
    } catch (error) {
      logger.error("Error:", error);
      process.exit(1);
    }
  });

// Initialize powerbank
program
  .command("initialize-powerbank")
  .description("Initialize a powerbank with ID and battery information")
  .requiredOption(
    "-i, --index <index>",
    `Slot index (${SLOT_INDEX_MINIMUM}-${SLOT_INDEX_MAXIMUM})`,
    cliInputValidatorIndex
  )
  .requiredOption(
    "--id <serialNumber>",
    "Powerbank serial number (exactly 10 characters)",
    (value: string) => {
      if (value.length !== 10) {
        throw new Error("Serial number must be exactly 10 characters");
      }
      return value;
    }
  )
  .option(
    "--total-charge <mAh>",
    "Total battery capacity in mAh (default: 13925)",
    (value: string) => {
      const charge = parseInt(value);
      if (isNaN(charge) || charge < 0 || charge > 65535) {
        throw new Error("Total charge must be between 0 and 65535 mAh");
      }
      return value;
    }
  )
  .option(
    "--current-charge <mAh>",
    "Current battery charge in mAh (default: 11625)",
    (value: string) => {
      const charge = parseInt(value);
      if (isNaN(charge) || charge < 0 || charge > 65535) {
        throw new Error("Current charge must be between 0 and 65535 mAh");
      }
      return value;
    }
  )
  .option(
    "--cutoff-charge <mAh>",
    "Cutoff battery charge in mAh (default: 10625)",
    (value: string) => {
      const charge = parseInt(value);
      if (isNaN(charge) || charge < 0 || charge > 65535) {
        throw new Error("Cutoff charge must be between 0 and 65535 mAh");
      }
      return value;
    }
  )
  .option(
    "--cycles <count>",
    "Battery cycle count (default: 0)",
    (value: string) => {
      const cycles = parseInt(value);
      if (isNaN(cycles) || cycles < 0 || cycles > 65535) {
        throw new Error("Cycles must be between 0 and 65535");
      }
      return value;
    }
  )
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      if (!options.id) {
        logger.error("Serial number (--id) is required");
        process.exit(1);
      }

      const serialNumber = options.id;
      const timestamp = Math.floor(Date.now() / 1000);
      const cycles = options.cycles ? parseInt(options.cycles) : 0;
      const totalCharge = options.totalCharge
        ? parseInt(options.totalCharge)
        : 13925;
      const currentCharge = options.currentCharge
        ? parseInt(options.currentCharge)
        : 11625;
      const cutoffCharge = options.cutoffCharge
        ? parseInt(options.cutoffCharge)
        : 10625;

      const port = await selectPort();
      const service = new SerialService(port);
      await service.connect();

      const slotMapping = mapSlotToBoard(parseInt(options.index));
      const command = new InitializePowerbankCommand(service);
      const response = await command.execute(
        slotMapping.boardAddress,
        slotMapping.slotInBoard,
        {
          serialNumber,
          timestamp,
          cycles,
          totalCharge,
          currentCharge,
          cutoffCharge,
        }
      );

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      if (response.success) {
        const result = {
          success: true,
          executionTimeMs: executionTime,
          timestamp: new Date().toISOString(),
          slotIndex: parseInt(options.index),
          boardAddress: slotMapping.boardAddress,
          slotInBoard: slotMapping.slotInBoard,
          powerbank: {
            serialNumber,
            manufacturingTimestamp: timestamp,
            cycles,
            totalCharge,
            currentCharge,
            cutoffCharge,
          },
        };
        logger.log(JSON.stringify(result, null, 2));
      } else {
        const result = {
          success: false,
          executionTimeMs: executionTime,
          timestamp: new Date().toISOString(),
          slotIndex: parseInt(options.index),
          boardAddress: slotMapping.boardAddress,
          slotInBoard: slotMapping.slotInBoard,
          error: {
            code: response.status,
            message: getStatusMessage(response.status),
          },
        };
        logger.log(JSON.stringify(result, null, 2));
        process.exit(1);
      }

      await service.disconnect();
    } catch (error) {
      const endTime = Date.now();
      const executionTime = endTime - startTime;

      const slotMapping = mapSlotToBoard(parseInt(options.index));
      const result = {
        success: false,
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString(),
        slotIndex: parseInt(options.index),
        boardAddress: slotMapping.boardAddress,
        slotInBoard: slotMapping.slotInBoard,
        error: {
          code: -1,
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };

      logger.log(JSON.stringify(result, null, 2));
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
        logger.log(
          "Firmware version:",
          `${response[2]}.${response[3]}.${response[4]}`
        );
      } else {
        logger.error("Command failed with status:", response[1]);
      }

      await service.disconnect();
    } catch (error) {
      logger.error("Error:", error);
      process.exit(1);
    }
  });

// Get model information
program
  .command("model")
  .description("Get board model and number of boards in daisy chain")
  .requiredOption("-b, --board <address>", "Board address (0-4)")
  .action(async (options: CommandOptions) => {
    const startTime = Date.now();
    try {
      const port = await selectPort();
      const service = new SerialService(port);
      await service.connect();

      const command = new ModelCommand(service);
      const response = await command.execute(parseInt(options.board));

      if (response.success) {
        const modelInfo = JSON.parse(response.data.toString());
        logger.log("Model:", modelInfo.model);
        logger.log("Board count:", modelInfo.boardCount);
        logger.log(`Execution time: ${Date.now() - startTime}ms`);
      } else {
        logger.error("Command failed with status:", response.status);
      }

      await service.disconnect();
    } catch (error) {
      logger.error("Error:", error);
      process.exit(1);
    }
  });

program.parse();
