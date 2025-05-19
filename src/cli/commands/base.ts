import { SerialService } from "../../services/serial";
import { SerialMessage, CommandResponse } from "../../protocol/types";

export abstract class BaseCommand {
  constructor(protected serialService: SerialService) {}

  protected async executeCommand(
    message: SerialMessage
  ): Promise<CommandResponse> {
    try {
      const response = await this.serialService.sendMessage(message);
      return {
        success: response[2] === 0,
        status: response[2],
        data: response.subarray(3),
      };
    } catch (error) {
      console.error("Command execution failed:", error);
      throw error;
    }
  }

  abstract execute(
    boardAddress: number,
    ...args: any[]
  ): Promise<CommandResponse>;
}
