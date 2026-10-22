import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { powerbankTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

/**
 * CMD_PB_ENTER_BOOT (0x10): app-side opcode. Tells the running powerbank
 * application to write the bootloader rendezvous magic at
 * FWU_RAM_MAGIC_ADDR and trigger a NVIC_SystemReset(). On the next boot
 * the bootloader sees the magic and stays in firmware-update mode
 * instead of jumping back to the app.
 *
 * The app acks the command before resetting, so on the wire we get a
 * normal [opcode][FWU_RES_SUCCESS] response. After that the device is
 * unresponsive for ~30 ms while it resets into the bootloader.
 */
export class PbEnterBootCommand extends BaseCommand {
  async execute(boardAddress: number, slotAddress: number): Promise<CommandResponse> {
    return new FwuWire(this.serialService, powerbankTarget(boardAddress, slotAddress)).enter();
  }
}
