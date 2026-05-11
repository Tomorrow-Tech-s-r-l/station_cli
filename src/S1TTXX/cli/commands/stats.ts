import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_STATS } from "../../../utils/constants";

export interface SlotUsageStats {
  unlockCount: number;
}

export interface StatsResult extends CommandResponse {
  slots?: SlotUsageStats[];
}

const STATS_NUM_SLOTS = 6;

export class StatsCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    reset: boolean = false
  ): Promise<StatsResult> {
    const message: SerialMessage = {
      boardAddress,
      command: CMD_STATS,
      data: Buffer.from([reset ? 1 : 0]),
    };

    const response = await this.executeCommand(message);
    if (
      !response.success ||
      response.data.length < STATS_NUM_SLOTS * 4
    ) {
      return response;
    }

    // Wire layout: 6 × u32 LE unlock_count.
    const slots: SlotUsageStats[] = [];
    for (let i = 0; i < STATS_NUM_SLOTS; i++) {
      slots.push({
        unlockCount: response.data.readUInt32LE(i * 4),
      });
    }
    return { ...response, slots };
  }
}
