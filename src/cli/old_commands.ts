/**
 * Simplified Commands for S0RUXX Protocol
 * 
 * Simple commands to:
 * - Query device info (CQ command)
 * - Unlock powerbank (FB command)
 */

import { Command } from "commander";
import { SerialService } from "../S0RUXX/services/serial";
import { QueryCommand } from "../S0RUXX/cli/commands/query";
import { UnlockCommand } from "../S0RUXX/cli/commands/unlock";
import { logger } from "../utils/logger";

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
 * Register simplified commands for S0RUXX protocol
 * @param program - Commander program instance
 */
export function registerOldCommands(program: Command): void {
  // Query command - sends CQ command to get device info
  program
    .command("s0ruxx-query")
    .alias("s0-query")
    .description("Query device information (sends {0@CQ,0,0,0000})")
    .action(async () => {
      try {
        const port = await selectPort();
        const service = new SerialService(port);
        await service.connect();
        
        const command = new QueryCommand(service);
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
    .action(async () => {
      try {
        const port = await selectPort();
        const service = new SerialService(port);
        await service.connect();
        
        const command = new UnlockCommand(service);
        await command.execute();
        
        await service.disconnect();
      } catch (error) {
        logger.error("Unlock error:", error);
        process.exit(1);
      }
    });
}
