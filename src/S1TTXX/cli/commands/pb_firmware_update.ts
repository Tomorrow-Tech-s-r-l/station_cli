import { SerialService } from "../../services/serial";
import {
  FwuSessionOptions,
  FwuSessionResult,
  runFwuSession,
} from "../../fwu/session/session";
import { powerbankTarget } from "../../fwu/session/target";

/**
 * Flash a new application image onto a powerbank over the half-duplex pogo line.
 *
 *   PB_ENTER_BOOT → settle → PB_FWU_HELLO → PB_FWU_BEGIN → loop PB_FWU_DATA
 *               → PB_FWU_END → PB_FWU_EXIT → settle
 *
 * The flow itself lives in `runFwuSession` (`fwu/session/session.ts`), shared
 * with the station path; this wrapper only binds it to a powerbank target
 * (opcodes 0x10..0x16, slot byte prepended). The exported names and result
 * shape are unchanged, so `fw-apply` and the `pb-firmware-update` command are
 * untouched.
 */

export interface PbFirmwareUpdateOptions extends FwuSessionOptions {
  /** Board the powerbank is docked in, routed through mapSlotToBoard() upstream. */
  boardAddress: number;
  /** Slot within that board, 0-5. */
  slotInBoard: number;
}

export type PbFirmwareUpdateResult = FwuSessionResult;

export async function runPbFirmwareUpdate(
  service: SerialService,
  opts: PbFirmwareUpdateOptions
): Promise<PbFirmwareUpdateResult> {
  return runFwuSession(service, powerbankTarget(opts.boardAddress, opts.slotInBoard), opts);
}
