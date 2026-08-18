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
  port?: string;
  index?: string;
}

/** Resolve the serial port: explicit --port wins, else auto-detect / env. */
async function resolvePort(portOpt?: string): Promise<string> {
  return portOpt && portOpt.length > 0 ? portOpt : await selectPort();
}

/** Query the slot map on an S0TTXX gateway. */
export async function runS0TTXXSlots(portOpt?: string): Promise<void> {
  const service = new SerialService(await resolvePort(portOpt));
  try {
    await service.connect();
    await new SlotsCommand(service).execute();
  } catch (error) {
    logger.error("Slots error:", error);
    process.exit(1);
  } finally {
    await service.disconnect();
  }
}

/** Unlock a slot on an S0TTXX gateway. */
export async function runS0TTXXUnlock(
  index: number,
  portOpt?: string
): Promise<void> {
  const service = new SerialService(await resolvePort(portOpt));
  try {
    await service.connect();
    await new UnlockCommand(service).execute(index);
  } catch (error) {
    logger.error("Unlock error:", error);
    process.exit(1);
  } finally {
    await service.disconnect();
  }
}

/**
 * Register S0TTXX commands. The gateway must be running the local serial
 * connector build (flash.sh --local); connect station_cli to the USART1
 * USB-serial cable.
 */
export function registerS0TTXXCommands(program: Command): void {
  program
    .command("s0ttxx-query")
    .alias("s0-query")
    .description("Get the slot map (sends cmd CQ → gateway forwards {0@CQ,0,0,<crc>})")
    .option("-p, --port <port>", "Serial port (default: auto-detect / STATION_CLI_PORT)")
    .action(async (options: CommandOptions) => {
      await runS0TTXXSlots(options.port);
    });

  program
    .command("s0ttxx-unlock")
    .alias("s0-unlock")
    .description("Unlock a slot (sends cmd FB → gateway forwards {0@FB,0,<ts>,<slot>,<crc>})")
    .requiredOption(
      "-i, --index <index>",
      `Slot index (${SLOT_INDEX_MINIMUM}-${getSlotIndexMaximum()})`,
      cliInputValidatorIndex
    )
    .option("-p, --port <port>", "Serial port (default: auto-detect / STATION_CLI_PORT)")
    .action(async (options: CommandOptions) => {
      await runS0TTXXUnlock(parseInt(options.index as string), options.port);
    });
}
