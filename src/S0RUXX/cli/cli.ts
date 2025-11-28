import { Command } from "commander";
import { SerialService } from "../services/serial";
import { StatusCommand } from "./commands/status";
import { UnlockCommand } from "./commands/unlock";
import { logger } from "../../utils/logger";
import {
  SLOT_INDEX_MAXIMUM,
  SLOT_INDEX_MINIMUM,
} from "../../S1TTXX/protocol/constants";
import { cliInputValidatorIndex } from "../../utils/cli_input_validator";

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
 * Select port for S0RUXX protocol
 */
async function selectPort(): Promise<string> {
  const service = new SerialService("");
  const ports = await service.listPorts();
  const filteredPorts = ports.filter(
    (p) =>
      p.includes("usbserial") ||
      p.includes("ttyUSB0") ||
      p.includes("tty.usbserial")
  );
  if (filteredPorts.length === 0) {
    throw new Error("No compatible serial port found");
  }
  return filteredPorts[0];
}

/**
 * Register all S0RUXX commands to the Commander program
 * @param program - Commander program instance
 */
export function registerS0RUXXCommands(program: Command): void {
  // Query command - sends CQ command to get device info
  program
    .command("s0ruxx-query")
    .alias("s0-query")
    .description("Get the status of all slots (sends {0@CQ,0,0,0000})")
    .action(async () => {
      try {
        const port = await selectPort();
        const service = new SerialService(port);
        await service.connect();

        const command = new StatusCommand(service);
        await command.execute();

        await service.disconnect();
      } catch (error) {
        logger.error("Query error:", error);
        process.exit(1);
      }
    });

  // Unlock command - sends FB command to unlock powerbank
  program
    .command("s0ruxx-unlock")
    .alias("s0-unlock")
    .description("Unlock powerbank (sends {0@FB,0,<timestamp>,1,0000})")
    .requiredOption(
      "-i, --index <index>",
      `Slot index (${SLOT_INDEX_MINIMUM}-${SLOT_INDEX_MAXIMUM})`,
      cliInputValidatorIndex
    )
    .action(async (options: CommandOptions) => {
      try {
        const port = await selectPort();
        const service = new SerialService(port);
        await service.connect();

        const slotIndex = parseInt(options.index);

        const command = new UnlockCommand(service);
        await command.execute(parseInt(options.index));

        await service.disconnect();
      } catch (error) {
        logger.error("Unlock error:", error);
        process.exit(1);
      }
    });
}
