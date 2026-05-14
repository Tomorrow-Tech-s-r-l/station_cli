import { BaseCommand } from "./base";
import { SerialMessage, CommandResponse } from "../../protocol/types";
import {
  CMD_ENTER_BOOT_CODE,
  MAXIMUM_SLOT_ADDRESS,
} from "../../../utils/constants";

/**
 * CMD_ENTER_BOOT (0x10): app-side opcode. Tells the running application to
 * write the bootloader rendezvous magic at FWU_RAM_MAGIC_ADDR and trigger a
 * NVIC_SystemReset(). On the next boot the bootloader sees the magic and
 * stays in firmware-update mode instead of jumping back to the app.
 *
 * The app acks the command before resetting, so on the wire we get a
 * normal [opcode][FWU_RES_SUCCESS] response. After that the device is
 * unresponsive for ~30 ms while it resets into the bootloader.
 */
export class EnterBootCommand extends BaseCommand {
  async execute(
    boardAddress: number,
    slotAddress: number
  ): Promise<CommandResponse> {
    if (slotAddress < 0 || slotAddress > MAXIMUM_SLOT_ADDRESS) {
      throw new Error(
        `Slot index must be between 0 and ${MAXIMUM_SLOT_ADDRESS}`
      );
    }

    const message: SerialMessage = {
      boardAddress,
      command: CMD_ENTER_BOOT_CODE,
      data: Buffer.from([slotAddress]),
    };

    return this.executeCommand(message);
  }
}
