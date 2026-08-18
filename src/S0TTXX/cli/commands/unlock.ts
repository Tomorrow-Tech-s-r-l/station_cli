import { SerialService } from "../../services/serial";
import { buildCmd, nextMid, Envelope } from "../../protocol/envelope";

/**
 * Unlock a slot on the S0TTXX gateway. Sends the SAME downlink `cmd` the MQTT
 * broker will send — the gateway wraps it into the OEM main-board frame
 * `{0@FB,0,<ts>,<slot>,<crc>}` and forwards it over the 3-pin host UART.
 *
 * FB (eject) has no guaranteed main-board reply (matching the OEM behaviour),
 * so this waits briefly for any correlated `resp`/`evt` and reports it if seen,
 * otherwise confirms the command was sent.
 */
export class UnlockCommand {
  private static lastTimestamp = 0;

  constructor(private serialService: SerialService) {}

  async execute(slotIndex: number): Promise<void> {
    // Incrementing "X" value carried in the command body (the OEM anti-replay
    // token). This is a plain millisecond timestamp string in the FRAME body,
    // distinct from the small envelope `mid` used for request/response matching.
    let timestamp = Date.now();
    if (timestamp <= UnlockCommand.lastTimestamp) {
      timestamp = UnlockCommand.lastTimestamp + 1;
    }
    UnlockCommand.lastTimestamp = timestamp;

    const mid = nextMid();
    const env = buildCmd(
      { mnem: "FB", addr: "0", body: `0,${timestamp},${slotIndex}` },
      mid
    );

    console.log(
      `Unlocking slot ${slotIndex} (mid=${mid}, ts=${timestamp}) — gateway will send {0@FB,0,${timestamp},${slotIndex},<crc>}`
    );

    // Listen before sending to avoid missing a fast reply.
    const respPromise = this.serialService.waitFor(
      (e: Envelope) =>
        (e.t === "resp" || e.t === "evt") &&
        (e.mid === mid || e.d?.slot === slotIndex),
      2000
    );
    await this.serialService.sendEnvelope(env);

    const resp = await respPromise;
    if (resp) {
      console.log("Response:", JSON.stringify(resp.d ?? resp));
    } else {
      console.log(
        "Unlock command sent. No response (FB has no main-board reply, or no main board is attached)."
      );
    }
  }
}
