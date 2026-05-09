import { SerialService } from "../../services/serial";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { debug } from "../../../utils/debug";
import {
  CMD_STATUS_CODE,
  CMD_SET_CHARGE_CODE,
  CMD_RESET_CODE,
  CMD_SET_PDO_CODE,
  CMD_SLOTS_CODE,
  CMD_UNLOCK_CODE,
  CMD_SET_LED_CODE,
  CMD_SET_INFO_PWB,
  CMD_SET_INFO_BATTERY,
  CMD_GET_FW_VER,
  STATUS_TIMEOUT,
} from "../../../utils/constants";

// Retry on transient powerbank-link timeouts (HOST_CMD_STATUS_ERR_TIMEOUT).
// The interface board returns this status when it didn't get a reply from the
// powerbank within its own 500ms window; with independent failures at p≈0.145
// observed in the field, two retries drop the residual rate to ≈0.003.
const PB_TIMEOUT_RETRIES = 2;
const PB_TIMEOUT_RETRY_DELAY_MS = 30;

// Helper function to get command name from command code
function getCommandName(commandCode: number): string {
  const commandNames: { [key: number]: string } = {
    [CMD_STATUS_CODE]: "STATUS",
    [CMD_SET_CHARGE_CODE]: "SET_CHARGE",
    [CMD_RESET_CODE]: "RESET",
    [CMD_SET_PDO_CODE]: "SET_PDO",
    [CMD_SLOTS_CODE]: "SLOTS",
    [CMD_UNLOCK_CODE]: "UNLOCK",
    [CMD_SET_LED_CODE]: "SET_LED",
    [CMD_SET_INFO_PWB]: "SET_INFO_PWB",
    [CMD_SET_INFO_BATTERY]: "SET_INFO_BATTERY",
    [CMD_GET_FW_VER]: "GET_FW_VER",
  };
  return commandNames[commandCode] || `UNKNOWN(0x${commandCode.toString(16)})`;
}

export abstract class BaseCommand {
  constructor(protected serialService: SerialService) {}

  protected async executeCommand(
    message: SerialMessage
  ): Promise<CommandResponse> {
    try {
      // Extract slot index from message data if present
      const slotIndex =
        message.data && message.data.length > 0 ? message.data[0] : undefined;

      // Log the start of the slot request
      const commandName = getCommandName(message.command);
      debug.slotRequest(commandName, message.boardAddress, slotIndex);

      let result: CommandResponse | undefined;
      for (let attempt = 0; attempt <= PB_TIMEOUT_RETRIES; attempt++) {
        const response = await this.serialService.sendMessage(message);
        result = {
          success: response[2] === 0,
          status: response[2],
          data: response.subarray(3),
        };
        if (result.status !== STATUS_TIMEOUT) {
          break;
        }
        if (attempt < PB_TIMEOUT_RETRIES) {
          debug.log(
            `Powerbank link timeout on ${commandName} (board=${message.boardAddress}, slot=${slotIndex}), retrying ${attempt + 1}/${PB_TIMEOUT_RETRIES}`
          );
          await new Promise((resolve) =>
            setTimeout(resolve, PB_TIMEOUT_RETRY_DELAY_MS)
          );
        }
      }

      // Log the end of the slot request
      debug.slotRequestEnd();

      return result!;
    } catch (error) {
      console.error("Command execution failed:", error);
      debug.slotRequestEnd();
      throw error;
    }
  }

  abstract execute(
    boardAddress: number,
    ...args: any[]
  ): Promise<CommandResponse>;
}
