import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import { CMD_STATION_FWU_ENTER_CODE } from "../../../utils/constants";

/**
 * CMD_STATION_FWU_ENTER (0x60): app-side opcode handled by the running
 * Zephyr application. Tells the app to write the bootloader rendezvous
 * magic at FWU_RAM_MAGIC_ADDR (0x20001FF0) and call sys_reboot(). On the
 * next boot the in-application bootloader at 0x08000000 sees the magic
 * and stays in firmware-update mode.
 *
 * Unlike the powerbank ENTER_BOOT (0x10) there is no slot index — this
 * targets the station board itself. The app acks with [opcode][SUCCESS]
 * before resetting, so on the wire we get a normal short response and
 * then the device is unresponsive for ~30 ms while it resets into BL.
 */
export class StationFwuEnterCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    const message: SerialMessage = {
      boardAddress,
      command: CMD_STATION_FWU_ENTER_CODE,
      data: Buffer.alloc(0),
    };
    return this.executeCommand(message);
  }
}
