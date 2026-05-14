import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_STATION_FWU_END_CODE } from "../../../utils/constants";

/**
 * CMD_STATION_FWU_END (0x64): bootloader-side. Verifies the rolling CRC32
 * of the received body bytes against the value declared at FWU_BEGIN, then
 * writes the app header page magic-last so a power loss mid-write leaves
 * the slot invalid. On success the BL idles in BL mode — call
 * STATION_FWU_EXIT to reset back into the new app.
 */
export class StationFwuEndCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    const message: SerialMessage = {
      boardAddress,
      command: CMD_STATION_FWU_END_CODE,
      data: Buffer.alloc(0),
    };
    return this.executeCommand(message);
  }
}
