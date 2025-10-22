import { BaseCommand } from "./base";
import {
  SerialMessage,
  CommandResponse,
  ModelResponsePayload,
} from "../../protocol/types";
import { CMD_MODEL } from "../../protocol/constants";

export class ModelCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    const message: SerialMessage = {
      boardAddress,
      command: CMD_MODEL,
    };

    const response = await this.executeCommand(message);
    if (response.success && response.data.length >= 9) {
      // Parse model response from firmware
      // Response format: <status> <model_string(8)> <board_count(1)>
      const modelString = response.data
        .subarray(1, 9) // Skip status byte, get 8-byte model string
        .toString("utf8")
        .trim()
        .replace(/\0/g, "");

      const boardCount = response.data.readUInt8(9);

      const modelInfo: ModelResponsePayload = {
        model: modelString,
        boardCount: boardCount,
      };

      return { ...response, data: Buffer.from(JSON.stringify(modelInfo)) };
    }
    return response;
  }
}
