import { SerialService } from "../../services/serial";
import { buildCmd, nextMid, Envelope } from "../../protocol/envelope";
import { parseSlotsFromRawFrame } from "../../utils/response_parser";

/**
 * Query the slot map. Sends a `cmd` with the CQ mnemonic; the gateway forwards
 * `{0@CQ,0,0,<crc>}` to the main board, which replies with an AC frame the
 * gateway relays back as a `tlm` (or `resp`) uplink carrying the raw frame in
 * `d.raw`. We parse that into the standardized slot view.
 */
export class SlotsCommand {
  constructor(private serialService: SerialService) {}

  async execute(): Promise<void> {
    const mid = nextMid();
    const env = buildCmd({ mnem: "CQ", addr: "0", body: "0,0" }, mid);

    // The AC map may come back as tlm (classified) or resp (correlated).
    const respPromise = this.serialService.waitFor((e: Envelope) => {
      if (e.t !== "tlm" && e.t !== "resp") return false;
      const raw: string = e.d?.raw ?? "";
      const mnem: string = e.d?.mnem ?? "";
      return mnem === "AC" || raw.includes("AC,");
    }, 5000);

    await this.serialService.sendEnvelope(env);

    const resp = await respPromise;
    if (!resp) {
      console.log(
        "No slot map received within 5 s (is a main board attached to the gateway?)."
      );
      return;
    }

    const parsed = parseSlotsFromRawFrame(resp.d?.raw ?? "");
    if (parsed) {
      console.log(JSON.stringify(parsed, null, 2));
    } else {
      console.log("Received a response but could not parse the AC frame:");
      console.log(JSON.stringify(resp, null, 2));
    }
  }
}
