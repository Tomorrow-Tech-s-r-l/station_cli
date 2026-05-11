import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_PB_LINK_STATS } from "../../../utils/constants";

export interface SlotLinkStats {
  attempts: number;
  retries: number;
  finalFailures: number;
}

export interface LinkStatsResult extends CommandResponse {
  slots?: SlotLinkStats[];
}

const STATS_NUM_SLOTS = 6;
const STATS_BYTES_PER_SLOT = 6; // 3 × uint16 LE

export class PbLinkStatsCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    reset: boolean = false
  ): Promise<LinkStatsResult> {
    const message: SerialMessage = {
      boardAddress,
      command: CMD_PB_LINK_STATS,
      data: Buffer.from([reset ? 1 : 0]),
    };

    const response = await this.executeCommand(message);
    if (
      !response.success ||
      response.data.length < STATS_NUM_SLOTS * STATS_BYTES_PER_SLOT
    ) {
      return response;
    }

    const slots: SlotLinkStats[] = [];
    for (let i = 0; i < STATS_NUM_SLOTS; i++) {
      const off = i * STATS_BYTES_PER_SLOT;
      slots.push({
        attempts: response.data.readUInt16LE(off),
        retries: response.data.readUInt16LE(off + 2),
        finalFailures: response.data.readUInt16LE(off + 4),
      });
    }
    return { ...response, slots };
  }
}
