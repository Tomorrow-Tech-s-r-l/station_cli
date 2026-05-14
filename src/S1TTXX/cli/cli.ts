import { Command } from "commander";
import {
  MAXIMUM_POWER_LEVEL,
  MAXIMUM_SLOT_ADDRESS,
  SLOT_INDEX_MINIMUM,
  SLOT_LOCKED,
  CMD_GET_FW_VER,
  STATUS_ERR_INTERNAL,
  PB_STATUS_CHARGING,
  PB_STATUS_PLUGGED_IN,
  PB_STATUS_IDLE,
} from "../../utils/constants";
import { PbLinkStatsCommand } from "./commands/pb_link_stats";
import { StatsCommand } from "./commands/stats";
import {
  SlotState,
  SlotError,
  SlotErrorInfo,
  SlotsResponse,
  SlotsInfo,
} from "../protocol/types";
import { debug } from "../../utils/debug";
import { selectPort } from "../../utils/port_selector";
import { getStatusMessage } from "../utils/status";
import { calculatePowerLevel } from "../utils/power_level";
import { logger } from "../../utils/logger";
import { SerialService } from "../services/serial";
import { SlotsCommand } from "./commands/slots";
import { StatusCommand } from "./commands/status";
import { UnlockCommand } from "./commands/unlock";
import { ChargeCommand } from "./commands/charge";
import { InitializePowerbankCommand } from "./commands/initialize_powerbank";
import {
  mapBoardToSlot,
  mapSlotToBoard,
  SLOT_IS_DISABLED_DEFAULT_VALUE,
  SLOT_IS_LOCKED_DEFAULT_VALUE,
} from "../utils/slot_mapping";
import { LedCommand } from "./commands/led";
import { EnterBootCommand } from "./commands/enter_boot";
import { FwuHelloCommand, FwuHelloInfo } from "./commands/fwu_hello";
import { FwuExitCommand } from "./commands/fwu_exit";
import { runFirmwareUpdate } from "./commands/firmware_update";
import {
  cliInputValidatorEnable,
  cliInputValidatorIndex,
} from "../../utils/cli_input_validator";
import { getMaximumBoardAddress, getSlotIndexMaximum } from "../../utils/model";

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

/**
 * Execute S1TTXX unlock for a given slot index.
 */
export async function runS1TTXXUnlock(index: number): Promise<void> {
  const startTime = Date.now();
  try {
    const port = await selectPort();
    const service = new SerialService(port);
    await service.connect();

    const command = new UnlockCommand(service);
    const response = await command.execute(index);

    const endTime = Date.now();
    const executionTime = endTime - startTime;

    if (response.success) {
      // Turn off led for unlocked slot
      const ledCommand = new LedCommand(service);
      await ledCommand.execute(index, false);
    }

    const result = {
      success: response.success,
      executionTimeMs: executionTime,
      timestamp: new Date().toISOString(),
      slotIndex: index,
      boardAddress: Math.floor((index - 1) / 6),
      slotInBoard: (index - 1) % 6,
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
      slotIndex: index,
      boardAddress: Math.floor((index - 1) / 6),
      slotInBoard: (index - 1) % 6,
      error: {
        code: -1,
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };

    logger.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

/**
 * Execute S1TTXX for all slots.
 */
export async function runS1TTXXSlots(): Promise<void> {
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

    for (let i = 0; i <= getMaximumBoardAddress(); i++) {
      try {
        const response = await command.execute(i);

        if (response.success) {
          try {
            const slotsInfo = JSON.parse(response.data.toString());
            debug.success("Slots status: ", slotsInfo);

            // Phase 1: Collect slot information for this board
            const boardSlots: Array<{
              slotIndex: number;
              isPowerbankPresent: boolean;
              powerBankInfo: any;
              powerLevel: number;
              needsCharging: boolean;
            }> = [];

            for (let j = 0; j <= MAXIMUM_SLOT_ADDRESS; j++) {
              const isPowerbankPresent = slotsInfo.lockedSlots[j] == SLOT_LOCKED;
              let powerBankInfo = null;
              let powerLevel = 0;
              let needsCharging = false;

              // Turn on led for available slot
              await ledCommand.execute(mapBoardToSlot(i, j), isPowerbankPresent);

              if (isPowerbankPresent) {
                // Get status of powerbank
                try {
                  const statusResponse = await statusCommand.execute(i, j);
                  if (statusResponse.success) {
                    powerBankInfo = JSON.parse(statusResponse.data.toString());
                    const currentCharge =
                      parseInt(powerBankInfo?.currentCharge) || 0;
                    const totalCharge =
                      parseInt(powerBankInfo?.totalCharge) || 0;
                    const cutoffCharge =
                      parseInt(powerBankInfo?.cutoffCharge) || 0;

                    powerLevel = calculatePowerLevel(
                      currentCharge,
                      totalCharge,
                      cutoffCharge
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
                      error instanceof Error ? error.message : "Unknown error",
                  });
                }
                // Wait 500ms before reading next powerbank information to avoid race conditions
                //await new Promise((resolve) => setTimeout(resolve, 1000));
              }

              boardSlots.push({
                slotIndex: j,
                isPowerbankPresent,
                powerBankInfo,
                powerLevel,
                needsCharging,
              });
            }

            // Phase 2: Determine which slot (if any) should charge
            // Rule: Only ONE powerbank per board can charge at a time
            // Priority 1: Keep powerbanks that are already charging (PB_STATUS_CHARGING)
            // Priority 2: If no powerbank is charging, charge the one with lowest currentCharge among PB_STATUS_PLUGGED_IN
            // Note: Powerbanks in PB_STATUS_IDLE (finished charging) are excluded from charging
            let chargingSlotIndex = -1;

            // First, check if any powerbank is currently charging - keep it charging
            for (const slot of boardSlots) {
              if (
                slot.isPowerbankPresent &&
                slot.powerBankInfo &&
                slot.powerBankInfo.status === PB_STATUS_CHARGING
              ) {
                chargingSlotIndex = slot.slotIndex;
                break;
              }
            }

            // If no powerbank is charging, find the one with lowest currentCharge among PB_STATUS_PLUGGED_IN
            // Exclude powerbanks that are in PB_STATUS_IDLE (finished charging) - they should not be charged again
            if (chargingSlotIndex === -1) {
              let lowestChargeSlot: {
                slotIndex: number;
                currentCharge: number;
              } | null = null;

              for (const slot of boardSlots) {
                if (
                  slot.isPowerbankPresent &&
                  slot.powerBankInfo &&
                  slot.powerBankInfo.status === PB_STATUS_PLUGGED_IN
                ) {
                  const currentCharge = slot.powerBankInfo.currentCharge || 0;
                  if (
                    lowestChargeSlot === null ||
                    currentCharge < lowestChargeSlot.currentCharge
                  ) {
                    lowestChargeSlot = {
                      slotIndex: slot.slotIndex,
                      currentCharge: currentCharge,
                    };
                  }
                }
              }

              if (lowestChargeSlot !== null) {
                chargingSlotIndex = lowestChargeSlot.slotIndex;
              }
            }

            // Phase 3: Apply charging commands and build response
            for (const slot of boardSlots) {
              const shouldCharge = slot.slotIndex === chargingSlotIndex;

              // Send charge command for available slots
              if (slot.isPowerbankPresent) {
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
                isPowerbankPresent: slot.isPowerbankPresent,
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
}

/**
 * Register all S1TTXX commands to the Commander program
 * @param program - Commander program instance
 */
export function registerS1TTXXCommands(program: Command): void {
  // Status command used to get the status of a powerbank in a specific board and slot
  program
    .command("status")
    .description("Get the status of a powerbank in a specific index")
    .requiredOption(
      "-i, --index <index>",
      `Slot index (${SLOT_INDEX_MINIMUM}-${getSlotIndexMaximum()})`,
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

        if (!slotsResp.success) {
          let error = {
            index: parseInt(options.index),
            boardAddress: slotMapping.boardAddress,
            slotIndex: slotMapping.slotInBoard,
            error: SlotError.SLOTS_COMMAND_FAILED,
            message: getStatusMessage(slotsResp.status),
          };
          logger.log(JSON.stringify(error, null, 2));
          await service.disconnect();
        } else {
          // Check if slot is available
          const slotsInfo = JSON.parse(slotsResp.data.toString());
          isAvailable =
            slotsInfo.lockedSlots[slotMapping.slotInBoard] == SLOT_LOCKED;
          const isPowerbankPresent =
            slotsInfo.filledSlots[slotMapping.slotInBoard] === 1;

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
                isPowerbankPresent,
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
                powerBankInfo?.totalCharge,
                powerBankInfo?.cutoffCharge
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
                  isPowerbankPresent,
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
      `Slot index (${SLOT_INDEX_MINIMUM}-${getSlotIndexMaximum()})`,
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
      `Slot index (${SLOT_INDEX_MINIMUM}-${getSlotIndexMaximum()})`,
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
      `Slot index (${SLOT_INDEX_MINIMUM}-${getSlotIndexMaximum()})`,
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

  // Per-slot powerbank link telemetry: attempts, retries, final timeouts.
  // Use --reset to clear the counters after reading (handy between test runs).
  program
    .command("pb-link-stats")
    .description("Get per-slot powerbank link retry telemetry")
    .requiredOption("-b, --board <address>", "Board address (0-4)")
    .option("--reset", "Clear counters after reading", false)
    .action(async (options: CommandOptions & { reset?: boolean }) => {
      try {
        const port = await selectPort();
        const service = new SerialService(port);
        await service.connect();

        const command = new PbLinkStatsCommand(service);
        const response = await command.execute(
          parseInt(options.board),
          options.reset === true
        );

        if (!response.success) {
          logger.error("Command failed with status:", response.status);
        } else if (!response.slots) {
          logger.error("Malformed response (no per-slot stats)");
        } else {
          logger.log("Per-slot powerbank link stats:");
          for (let i = 0; i < response.slots.length; i++) {
            const s = response.slots[i];
            const attempted = s.attempts;
            const succeededFirstTry = Math.max(
              0,
              s.attempts - s.retries - s.finalFailures
            );
            const recoveredByRetry = Math.max(
              0,
              s.retries - s.finalFailures
            );
            const ratePct =
              attempted > 0
                ? ((s.finalFailures / attempted) * 100).toFixed(2)
                : "0.00";
            logger.log(
              `  slot ${i}: attempts=${attempted}  retries=${s.retries}  ` +
                `final_failures=${s.finalFailures}  ` +
                `(first-try=${succeededFirstTry}, recovered=${recoveredByRetry}, residual=${ratePct}%)`
            );
          }
          if (options.reset) {
            logger.log("(counters cleared)");
          }
        }

        await service.disconnect();
      } catch (error) {
        logger.error("Error:", error);
        process.exit(1);
      }
    });

  // Lifetime per-slot solenoid trigger counters. Persisted to flash hourly.
  // Use --reset to read+clear+flush in one shot.
  program
    .command("stats")
    .description("Get per-slot solenoid usage counters")
    .requiredOption("-b, --board <address>", "Board address (0-4)")
    .option("--reset", "Clear counters after reading and flush to flash", false)
    .action(async (options: CommandOptions & { reset?: boolean }) => {
      try {
        const port = await selectPort();
        const service = new SerialService(port);
        await service.connect();

        const command = new StatsCommand(service);
        const response = await command.execute(
          parseInt(options.board),
          options.reset === true
        );

        if (!response.success) {
          logger.error("Command failed with status:", response.status);
        } else if (!response.slots) {
          logger.error("Malformed response (no per-slot stats)");
        } else {
          logger.log("Per-slot usage counters:");
          for (let i = 0; i < response.slots.length; i++) {
            const s = response.slots[i];
            logger.log(`  slot ${i}: unlocks=${s.unlockCount}`);
          }
          if (options.reset) {
            logger.log("(counters cleared and flushed to flash)");
          }
        }

        await service.disconnect();
      } catch (error) {
        logger.error("Error:", error);
        process.exit(1);
      }
    });

  // ---- Firmware-update (FWU) commands ---------------------------------
  //
  // Three thin one-shot commands that exercise the Phase 3 bootloader
  // protocol. They route by slot index just like `status`/`charge`/`led`.
  //
  //   enter-boot -i <index>   App -> ack + soft reset into the bootloader
  //   fwu-hello  -i <index>   BL  -> returns BL version + slot info
  //   fwu-exit   -i <index>   BL  -> ack + soft reset back into the app
  //
  // The bootloader is unresponsive for ~30 ms while it resets across an
  // ENTER_BOOT or FWU_EXIT, so a script that chains the three should
  // sleep ~200 ms between them.

  program
    .command("enter-boot")
    .description(
      "Tell the powerbank app to reset into the bootloader (CMD_ENTER_BOOT 0x10)"
    )
    .requiredOption(
      "-i, --index <index>",
      `Slot index (${SLOT_INDEX_MINIMUM}-${getSlotIndexMaximum()})`,
      cliInputValidatorIndex
    )
    .action(async (options: CommandOptions) => {
      const startTime = Date.now();
      const index = parseInt(options.index);
      const slotMapping = mapSlotToBoard(index);
      try {
        const port = await selectPort();
        const service = new SerialService(port);
        await service.connect();

        const command = new EnterBootCommand(service);
        const response = await command.execute(
          slotMapping.boardAddress,
          slotMapping.slotInBoard
        );

        const result = {
          success: response.success,
          executionTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          slotIndex: index,
          boardAddress: slotMapping.boardAddress,
          slotInBoard: slotMapping.slotInBoard,
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
        const result = {
          success: false,
          executionTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          slotIndex: index,
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

  program
    .command("fwu-hello")
    .description(
      "Query the powerbank bootloader for version + slot info (CMD_FWU_HELLO 0x11)"
    )
    .requiredOption(
      "-i, --index <index>",
      `Slot index (${SLOT_INDEX_MINIMUM}-${getSlotIndexMaximum()})`,
      cliInputValidatorIndex
    )
    .action(async (options: CommandOptions) => {
      const startTime = Date.now();
      const index = parseInt(options.index);
      const slotMapping = mapSlotToBoard(index);
      try {
        const port = await selectPort();
        const service = new SerialService(port);
        await service.connect();

        const command = new FwuHelloCommand(service);
        const response = await command.execute(
          slotMapping.boardAddress,
          slotMapping.slotInBoard
        );

        let bootloader: FwuHelloInfo | null = null;
        if (response.success) {
          try {
            bootloader = JSON.parse(response.data.toString()) as FwuHelloInfo;
          } catch {
            // Bootloader payload was shorter than 15 bytes — surface as a
            // protocol error rather than a parse crash.
          }
        }

        const result = {
          success: response.success && bootloader !== null,
          executionTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          slotIndex: index,
          boardAddress: slotMapping.boardAddress,
          slotInBoard: slotMapping.slotInBoard,
          bootloader,
          error:
            response.success && bootloader !== null
              ? null
              : {
                  code: response.status,
                  message: !response.success
                    ? getStatusMessage(response.status)
                    : "Malformed FWU_HELLO response payload",
                },
        };
        logger.log(JSON.stringify(result, null, 2));

        await service.disconnect();
      } catch (error) {
        const result = {
          success: false,
          executionTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          slotIndex: index,
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

  // ---- firmware-update orchestrator ---------------------------------
  //
  // End-to-end Phase 5 flow: read the .bin, IEEE-802.3 CRC32 it,
  // ENTER_BOOT → FWU_HELLO → FWU_BEGIN → loop FWU_DATA → FWU_END →
  // FWU_EXIT. Honors RES_OFFSET_MISMATCH and falls back to FWU_ABORT on
  // mid-stream failure so the slot is cleanly invalidated.
  program
    .command("firmware-update")
    .description(
      "Flash a new application image onto a powerbank via the pogo line"
    )
    .requiredOption(
      "-i, --index <index>",
      `Slot index (${SLOT_INDEX_MINIMUM}-${getSlotIndexMaximum()})`,
      cliInputValidatorIndex
    )
    .requiredOption(
      "--image <path>",
      "Path to the .bin image to flash (typically build/P1TT2C-firmware.bin)"
    )
    .option(
      "--app-version <hex>",
      "App version stamped into the header as (major<<16)|(minor<<8)|patch. Defaults to 0x00040000. (Not to be confused with the top-level CLI --version flag.)",
      "0x00040000"
    )
    .option("--verbose", "Print per-chunk progress", false)
    .option(
      "--inter-chunk-delay <ms>",
      "Extra wait between consecutive FWU_DATA chunks. The station inserts ~50 ms after every command on its own — this knob is for situations where that's not enough breathing room for the BL's half-duplex direction-switch to settle. Default 0.",
      "0"
    )
    .action(
      async (
        options: CommandOptions & {
          image?: string;
          appVersion?: string;
          verbose?: boolean;
          interChunkDelay?: string;
        }
      ) => {
        const startTime = Date.now();
        const index = parseInt(options.index);
        const slotMapping = mapSlotToBoard(index);
        try {
          if (!options.image) {
            throw new Error("--image is required");
          }
          const version = parseInt(options.appVersion ?? "0x00040000", 16) >>> 0;
          const interChunkDelayMs = parseInt(options.interChunkDelay ?? "0", 10);

          const port = await selectPort();
          const service = new SerialService(port);
          await service.connect();

          const r = await runFirmwareUpdate(service, {
            boardAddress: slotMapping.boardAddress,
            slotInBoard: slotMapping.slotInBoard,
            imagePath: options.image,
            version,
            verbose: options.verbose === true,
            interChunkDelayMs,
          });

          const out = {
            success: r.success,
            executionTimeMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
            slotIndex: index,
            boardAddress: slotMapping.boardAddress,
            slotInBoard: slotMapping.slotInBoard,
            image: {
              path: r.imagePath,
              sizeBytes: r.imageSize,
              crc32: r.imageCrc32,
              version,
            },
            chunks: r.chunks,
            retries: r.retries,
            durationMs: r.durationMs,
            bootloader: r.blInfo,
            error: r.error,
          };
          logger.log(JSON.stringify(out, null, 2));

          await service.disconnect();
          if (!r.success) {
            process.exit(1);
          }
        } catch (error) {
          const result = {
            success: false,
            executionTimeMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
            slotIndex: index,
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
      }
    );

  program
    .command("fwu-exit")
    .description(
      "Tell the bootloader to reset back into the app (CMD_FWU_EXIT 0x16)"
    )
    .requiredOption(
      "-i, --index <index>",
      `Slot index (${SLOT_INDEX_MINIMUM}-${getSlotIndexMaximum()})`,
      cliInputValidatorIndex
    )
    .action(async (options: CommandOptions) => {
      const startTime = Date.now();
      const index = parseInt(options.index);
      const slotMapping = mapSlotToBoard(index);
      try {
        const port = await selectPort();
        const service = new SerialService(port);
        await service.connect();

        const command = new FwuExitCommand(service);
        const response = await command.execute(
          slotMapping.boardAddress,
          slotMapping.slotInBoard
        );

        const result = {
          success: response.success,
          executionTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          slotIndex: index,
          boardAddress: slotMapping.boardAddress,
          slotInBoard: slotMapping.slotInBoard,
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
        const result = {
          success: false,
          executionTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          slotIndex: index,
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
}
