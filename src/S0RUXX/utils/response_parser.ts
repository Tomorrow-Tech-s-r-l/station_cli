// Buffer is a Node.js built-in, no import needed

/**
 * Parses S0RUXX AC (Active Report) response payload
 * 
 * Format: 0,DeviceID,FirmwareVersion,SlotCount,Status1,Status2,Status3,Slot1Data,Slot2Data,...,Checksum
 * 
 * Slot Data Format: SlotNumber:FillStatus:SerialNumber:PowerLevel:Status
 * - SlotNumber: 1-6
 * - FillStatus: 0=empty, 1=filled
 * - SerialNumber: Device serial number or "NULL"
 * - PowerLevel: Battery power level (0-100)
 * - Status: Status code (e.g., 001, 101)
 */
export interface ParsedSlotData {
  slotNumber: number;
  fillStatus: number; // 0 = empty, 1 = filled
  serialNumber: string | null;
  powerLevel: number;
  status: string;
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
 * Parses the AC response payload from bytes to JSON
 */
export function parseACResponse(data: Buffer): ParsedACResponse | null {
  try {
    // Find the start of the ASCII string (skip any leading null bytes)
    let startIndex = 0;
    while (startIndex < data.length && data[startIndex] === 0) {
      startIndex++;
    }
    
    if (startIndex >= data.length) {
      return null;
    }
    
    // Convert buffer to ASCII string, starting from first non-null byte
    const payloadString = data.subarray(startIndex).toString("ascii").trim();
    
    // Remove trailing checksum if present (last 4 hex chars)
    // The checksum appears to be at the end (e.g., "3ea0")
    let dataString = payloadString;
    const checksumMatch = payloadString.match(/([0-9a-fA-F]{4})$/);
    let checksum: string | undefined;
    
    if (checksumMatch) {
      checksum = checksumMatch[1];
      // Remove checksum from data string
      dataString = payloadString.slice(0, -4).trim();
    }
    
    // Split by comma
    const parts = dataString.split(",");
    
    if (parts.length < 7) {
      return null;
    }
    
    // Parse header fields
    const messageId = parts[0] || "0";
    const deviceId = parts[1] || "";
    const firmwareVersion = parts[2] || "";
    const slotCount = parseInt(parts[3] || "0", 10);
    const status1 = parseInt(parts[4] || "0", 10);
    const status2 = parseInt(parts[5] || "0", 10);
    const status3 = parseInt(parts[6] || "0", 10);
    
    // Parse slot data (everything after status3)
    const slots: ParsedSlotData[] = [];
    for (let i = 7; i < parts.length; i++) {
      const slotData = parts[i];
      if (!slotData) continue;
      
      // Slot format: SlotNumber:FillStatus:SerialNumber:PowerLevel:Status
      const slotParts = slotData.split(":");
      if (slotParts.length >= 5) {
        const slotNumber = parseInt(slotParts[0] || "0", 10);
        const fillStatus = parseInt(slotParts[1] || "0", 10);
        const serialNumber = slotParts[2] === "NULL" ? null : slotParts[2] || null;
        const powerLevel = parseInt(slotParts[3] || "0", 10);
        const status = slotParts[4] || "";
        
        slots.push({
          slotNumber,
          fillStatus,
          serialNumber,
          powerLevel,
          status,
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
