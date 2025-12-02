import { Command } from "commander";
import { SerialService } from "../services/serial";
import { SlotsCommand } from "./commands/slots";
import { UnlockCommand } from "./commands/unlock";
import { logger } from "../../utils/logger";
import { SLOT_INDEX_MINIMUM } from "../../utils/constants";
import { cliInputValidatorIndex } from "../../utils/cli_input_validator";
import { getSlotIndexMaximum } from "../../utils/model";
import { selectPort } from "../../utils/port_selector";

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
 * Execute S0RUXX status (CQ query for all slots).
 */
export async function runS0RUXXSlots(): Promise<void> {
  try {
    const port = await selectPort();
    const service = new SerialService(port);
    await service.connect();

    const command = new SlotsCommand(service);
    await command.execute();

    await service.disconnect();
  } catch (error) {
    logger.error("Slots error:", error);
    process.exit(1);
  }
}

/**
 * Execute S0RUXX unlock for a given slot index.
 */
export async function runS0RUXXUnlock(index: number): Promise<void> {
  try {
    const port = await selectPort();
    const service = new SerialService(port);
    await service.connect();

    const command = new UnlockCommand(service);
    await command.execute(index);

    await service.disconnect();
  } catch (error) {
    logger.error("Unlock error:", error);
    process.exit(1);
  }
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
      await runS0RUXXSlots();
    });

  // Unlock command - sends FB command to unlock powerbank
  program
    .command("s0ruxx-unlock")
    .alias("s0-unlock")
    .description("Unlock powerbank (sends {0@FB,0,<timestamp>,1,0000})")
    .requiredOption(
      "-i, --index <index>",
      `Slot index (${SLOT_INDEX_MINIMUM}-${getSlotIndexMaximum()})`,
      cliInputValidatorIndex
    )
    .action(async (options: CommandOptions) => {
      const slotIndex = parseInt(options.index);
      await runS0RUXXUnlock(slotIndex);
    });
}
