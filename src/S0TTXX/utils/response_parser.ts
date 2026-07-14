// Buffer is a Node.js built-in, no import needed
//
// Parses the main-board AC (Active Report) slot map that the S0TTXX gateway
// relays verbatim in an uplink envelope's `d.raw` (see CLOUD_PROTOCOL.md §5.3).
// The vendor payload format is unchanged from the OEM NETCHECK board, so this
// is the S0RUXX parser retargeted to take a raw `{..@AC,..}` frame string.

export interface ParsedSlotData {
  slotNumber: number;
  fillStatus: number; // 0 = empty, 1 = filled
  serialNumber: string | null;
  powerLevel: number;
  status: string;
}

export interface StandardizedSlotStatus {
  available: boolean;
  charging: boolean;
}

export interface StandardizedSlotInfo {
  slotNumber: number;
  powerBank: { id: string; powerLevel: number } | null;
  isPowerbankPresent: boolean;
  available: boolean;
  charging: boolean;
}

export interface StandardizedQueryResponse {
  deviceId: string;
  firmwareVersion: string;
  slotCount: number;
  slots: StandardizedSlotInfo[];
  checksum?: string;
}

export interface ParsedACResponse {
  messageId: string;
  deviceId: string;
  firmwareVersion: string;
  slotCount: number;
  status1: number;
  status2: number;
  status3: number;
  slots: ParsedSlotData[];
  checksum?: string;
}

/**
 * Converts a 3-char vendor slot status ("ABC") to the standardized shape used
 * across the CLI. A=charging, B=contact(0=in contact), C=lock(1=locked).
 */
export function convertSlotStatusToStandardized(
  statusString: string,
  serialNumber: string | null
): StandardizedSlotStatus {
  if (!statusString || statusString.length < 3) {
    return { available: false, charging: false };
  }
  const chargingChar = statusString[0];
  const contactChar = statusString[1];
  const lockChar = statusString[2];
  const available =
    contactChar === "0" && lockChar === "1" && serialNumber !== null;
  const charging = chargingChar === "1";
  return { available, charging };
}

/** Parses the AC payload bytes to structured fields. */
export function parseACResponse(data: Buffer): ParsedACResponse | null {
  try {
    let startIndex = 0;
    while (startIndex < data.length && data[startIndex] === 0) startIndex++;
    if (startIndex >= data.length) return null;

    const payloadString = data.subarray(startIndex).toString("ascii").trim();

    let dataString = payloadString;
    const checksumMatch = payloadString.match(/([0-9a-fA-F]{4})$/);
    let checksum: string | undefined;
    if (checksumMatch) {
      checksum = checksumMatch[1];
      dataString = payloadString.slice(0, -4).trim();
    }
    // Drop a dangling separator left by trimming the CRC.
    dataString = dataString.replace(/,$/, "");

    const parts = dataString.split(",");
    if (parts.length < 7) return null;

    const messageId = parts[0] || "0";
    const deviceId = parts[1] || "";
    const firmwareVersion = parts[2] || "";
    const slotCount = parseInt(parts[3] || "0", 10);
    const status1 = parseInt(parts[4] || "0", 10);
    const status2 = parseInt(parts[5] || "0", 10);
    const status3 = parseInt(parts[6] || "0", 10);

    const slots: ParsedSlotData[] = [];
    for (let i = 7; i < parts.length; i++) {
      const slotData = parts[i];
      if (!slotData) continue;
      const slotParts = slotData.split(":");
      if (slotParts.length >= 5) {
        slots.push({
          slotNumber: parseInt(slotParts[0] || "0", 10),
          fillStatus: parseInt(slotParts[1] || "0", 10),
          serialNumber: slotParts[2] === "NULL" ? null : slotParts[2] || null,
          powerLevel: parseInt(slotParts[3] || "0", 10),
          status: slotParts[4] || "",
        });
      }
    }

    return {
      messageId,
      deviceId,
      firmwareVersion,
      slotCount,
      status1,
      status2,
      status3,
      slots,
      checksum,
    };
  } catch (error) {
    console.error("Error parsing AC response:", error);
    return null;
  }
}

/**
 * Parse a relayed main-board frame (e.g. "{0@AC,..}" or "@AC,..}") into the
 * standardized query response, or null if it isn't a parseable AC frame.
 */
export function parseSlotsFromRawFrame(
  raw: string
): StandardizedQueryResponse | null {
  if (!raw) return null;

  // Isolate "AC,<payload>[,<crc>]" from whatever framing/prefix the frame has.
  const acIdx = raw.indexOf("AC,");
  if (acIdx === -1) return null;
  let tail = raw.slice(acIdx + 3); // after "AC,"
  const brace = tail.indexOf("}");
  if (brace !== -1) tail = tail.slice(0, brace);

  // Prepend a null byte to match the OEM payload framing parseACResponse expects.
  const dataBuffer = Buffer.from(tail, "ascii");
  const fullBuffer = Buffer.alloc(dataBuffer.length + 1);
  fullBuffer.writeUInt8(0, 0);
  dataBuffer.copy(fullBuffer, 1);

  const parsed = parseACResponse(fullBuffer);
  if (!parsed) return null;

  return {
    deviceId: parsed.deviceId,
    firmwareVersion: parsed.firmwareVersion,
    slotCount: parsed.slotCount,
    slots: parsed.slots.map((slot) => {
      const std = convertSlotStatusToStandardized(slot.status, slot.serialNumber);
      return {
        slotNumber: slot.slotNumber,
        powerBank:
          slot.serialNumber !== null
            ? { id: slot.serialNumber, powerLevel: slot.powerLevel }
            : null,
        isPowerbankPresent: slot.fillStatus === 1,
        available: std.available,
        charging: std.charging,
      };
    }),
    checksum: parsed.checksum,
  };
}
