import inquirer from "inquirer";
import chalk from "chalk";
import { SerialService } from "../services/serial";
import {
  MAXIMUM_BOARD_ADDRESS,
  MAXIMUM_SLOT_INDEX,
  MINIMUM_POWER_LEVEL,
  MAXIMUM_POWER_LEVEL,
} from "../protocol/constants";

export const validateBoardAddress = (value: string) => {
  const address = parseInt(value);
  if (isNaN(address) || address < 0 || address > MAXIMUM_BOARD_ADDRESS) {
    throw new Error(
      `Board address must be between 0 and ${MAXIMUM_BOARD_ADDRESS}`
    );
  }
  return address;
};

export const validateSlotIndex = (value: string) => {
  const slot = parseInt(value);
  if (isNaN(slot) || slot < 0 || slot > MAXIMUM_SLOT_INDEX) {
    throw new Error(`Slot index must be between 0 and ${MAXIMUM_SLOT_INDEX}`);
  }
  return slot;
};

export const validatePowerLevel = (value: string) => {
  const power = parseInt(value);
  if (
    isNaN(power) ||
    power < MINIMUM_POWER_LEVEL ||
    power > MAXIMUM_POWER_LEVEL
  ) {
    throw new Error(
      `Power level must be between ${MINIMUM_POWER_LEVEL} and ${MAXIMUM_POWER_LEVEL}`
    );
  }
  return power;
};

export const handleSerialError = (error: Error) => {
  console.error("Serial error occurred:", error);

  const errorMessage = error.message.toLowerCase();
  if (errorMessage.includes("timeout")) {
    console.error(
      chalk.red("\nError: Command timed out. This could be due to:"),
      "\n  1. The device is not responding",
      "\n  2. The device is busy processing another command",
      "\n  3. The connection is unstable",
      "\n\nPlease try again or check the device connection."
    );
  } else if (errorMessage.includes("port not connected")) {
    console.error(
      chalk.red("\nError: Serial port is not connected."),
      "\nPlease ensure:",
      "\n  1. The device is properly connected",
      "\n  2. The correct port is selected",
      "\n  3. No other program is using the port"
    );
  } else {
    console.error(chalk.red("\nError:"), error.message);
  }
  console.log(chalk.yellow("\nPress Enter to continue..."));
};

export const ensureSerialConnection = async (
  portPath: string,
  serialService: SerialService | null
): Promise<SerialService> => {
  if (!serialService) {
    const service = new SerialService(portPath);
    await service.connect();
    return service;
  }
  return serialService;
};

export const selectAndConnectPort = async (): Promise<{
  service: SerialService;
  port: string;
}> => {
  const service = new SerialService("");
  const ports = await service.listPorts();

  if (ports.length === 0) {
    console.error(
      chalk.red("\nNo serial ports found!"),
      "\nPlease ensure:",
      "\n  1. Your device is connected",
      "\n  2. The correct drivers are installed",
      "\n  3. The device is powered on"
    );
    process.exit(1);
  }

  console.log("Available ports:", ports);
  const { port } = await inquirer.prompt([
    {
      type: "list",
      name: "port",
      message: "Select a serial port:",
      choices: ports,
    },
  ]);

  const newService = new SerialService(port);
  try {
    console.log("Attempting to connect to port");
    await newService.connect();
    console.log(chalk.green("\nSuccessfully connected to port:", port));
    return { service: newService, port };
  } catch (error) {
    console.error("Failed to connect to port:", error);
    console.error(
      chalk.red("\nFailed to connect to port:", port),
      "\nPlease ensure:",
      "\n  1. The port is not in use by another program",
      "\n  2. You have the necessary permissions",
      "\n  3. The device is properly connected"
    );
    process.exit(1);
  }
};

export const promptBoardAddress = async (): Promise<number> => {
  const { board } = await inquirer.prompt([
    {
      type: "input",
      name: "board",
      message: "Enter board address (0-4):",
      validate: (input: string) => {
        const value = parseInt(input);
        if (isNaN(value) || value < 0 || value > MAXIMUM_BOARD_ADDRESS) {
          return `Please enter a number between 0 and ${MAXIMUM_BOARD_ADDRESS}`;
        }
        return true;
      },
    },
  ]);
  return parseInt(board);
};

export const promptSlotIndex = async (): Promise<number> => {
  const { slot } = await inquirer.prompt([
    {
      type: "input",
      name: "slot",
      message: "Enter slot index (0-6):",
      validate: (input: string) => {
        const value = parseInt(input);
        if (isNaN(value) || value < 0 || value > MAXIMUM_SLOT_INDEX) {
          return `Please enter a number between 0 and ${MAXIMUM_SLOT_INDEX}`;
        }
        return true;
      },
    },
  ]);
  return parseInt(slot);
};

export const promptPowerLevel = async (): Promise<number> => {
  const { power } = await inquirer.prompt([
    {
      type: "input",
      name: "power",
      message: `Enter power level (${MINIMUM_POWER_LEVEL}-${MAXIMUM_POWER_LEVEL}):`,
      validate: (input: string) => {
        const value = parseInt(input);
        if (
          isNaN(value) ||
          value < MINIMUM_POWER_LEVEL ||
          value > MAXIMUM_POWER_LEVEL
        ) {
          return `Please enter a number between ${MINIMUM_POWER_LEVEL} and ${MAXIMUM_POWER_LEVEL}`;
        }
        return true;
      },
    },
  ]);
  return parseInt(power);
};
