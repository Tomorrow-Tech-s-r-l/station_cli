import { BaseCommand } from "./base";
import { CommandResponse } from "../../protocol/types";
import { FwuWire } from "../../fwu/session/wire";
import { stationTarget } from "../../fwu/session/target";

// Thin wrapper over FwuWire (fwu/session/wire.ts). Behaviour pinned by
// tests/golden/fwu/ and tests/fwu_wire_validation.test.js.

/**
 * CMD_FWU_ENTER (0x60): app-side opcode handled by the running Zephyr
 * application. Tells the app to write the bootloader rendezvous magic
 * at FWU_RAM_MAGIC_ADDR (0x20001FF0) and call sys_reboot(). On the
 * next boot the in-application bootloader at 0x08000000 sees the
 * magic and stays in firmware-update mode.
 *
 * Unlike the powerbank PB_ENTER_BOOT (0x10) there is no slot index —
 * this targets the station board itself. The app acks with
 * [opcode][SUCCESS] before resetting, so on the wire we get a normal
 * short response and then the device is unresponsive for ~30 ms while
 * it resets into BL.
 */
export class FwuEnterCommand extends BaseCommand {
  async execute(boardAddress: number): Promise<CommandResponse> {
    return new FwuWire(this.serialService, stationTarget(boardAddress)).enter();
  }
}
