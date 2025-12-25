import { Command } from "commander";
import { SerialService } from "../services/serial";
import { DualPortSerialService } from "../services/dual_port_serial";
import { SlotsCommand } from "./commands/slots";
import { UnlockCommand } from "./commands/unlock";
import { logger } from "../../utils/logger";
import { SLOT_INDEX_MINIMUM } from "../../utils/constants";
import { cliInputValidatorIndex } from "../../utils/cli_input_validator";
import { getSlotIndexMaximum, getModel } from "../../utils/model";
import { selectPort, selectPorts } from "../../utils/port_selector";

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
    const model = getModel();
    
    if (model === "S0RU30") {
      // S0RU30 uses two ports
      const [port0, port1] = await selectPorts();
      const dualService = new DualPortSerialService(port0, port1);
      await dualService.connect();

      const command = new SlotsCommand(dualService);
      await command.execute();

      await dualService.disconnect();
    } else {
      // S0RU6 uses single port
      const port = await selectPort();
      const service = new SerialService(port);
      await service.connect();

      const command = new SlotsCommand(service);
      await command.execute();

      await service.disconnect();
    }
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
    const model = getModel();
    
    if (model === "S0RU30") {
      // S0RU30 uses two ports - route to correct board and map slot index
      const [port0, port1] = await selectPorts();
      const dualService = new DualPortSerialService(port0, port1);
      await dualService.connect();

      // Get the service for the board handling this slot
      const service = dualService.getServiceForSlot(index);
      // Map global slot index (1-30) to local board slot index (1-18 or 1-12)
      const localSlotIndex = DualPortSerialService.mapToLocalSlotIndex(index);

      const command = new UnlockCommand(service);
      await command.execute(localSlotIndex);

      await dualService.disconnect();
    } else {
      // S0RU6 uses single port
      const port = await selectPort();
      const service = new SerialService(port);
      await service.connect();

      const command = new UnlockCommand(service);
      await command.execute(index);

      await service.disconnect();
    }
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
