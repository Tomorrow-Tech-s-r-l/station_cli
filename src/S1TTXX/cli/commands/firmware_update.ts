import { SerialService } from "../../services/serial";
import {
  FwuSessionOptions,
  FwuSessionResult,
  runFwuSession,
} from "../../fwu/session/session";
import { stationTarget } from "../../fwu/session/target";

/**
 * Flash a new application image onto a station board over USART1 (RS-485).
 *
 *   FWU_ENTER → settle → FWU_HELLO → FWU_BEGIN → loop FWU_DATA
 *     → FWU_END → FWU_EXIT → settle
 *
 * The flow itself lives in `runFwuSession` (`fwu/session/session.ts`), shared
 * with the powerbank path; this wrapper only binds it to a station target
 * (opcodes 0x60..0x66, addressed by board). The exported names and result
 * shape are unchanged, so `fw-apply` and the `firmware-update` command are
 * untouched.
 */

export interface StationFirmwareUpdateOptions extends FwuSessionOptions {
  /** Board address from PB4..PB7 DIP switches on the target station. */
  boardAddress: number;
}

export type StationFirmwareUpdateResult = FwuSessionResult;

export async function runStationFirmwareUpdate(
  service: SerialService,
  opts: StationFirmwareUpdateOptions
): Promise<StationFirmwareUpdateResult> {
  return runFwuSession(service, stationTarget(opts.boardAddress), opts);
}
