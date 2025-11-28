import { SerialService } from "../../services/serial";
import {
  parseACResponse,
  convertSlotStatusToStandardized,
} from "../../utils/response_parser";

export interface StandardizedSlotInfo {
  slotNumber: number;
  powerBank: {
    id: string;
    powerLevel: number;
  } | null;
  available: boolean;
  charging: boolean;
  outputting: boolean;
}

export interface StandardizedQueryResponse {
  messageId: string;
  deviceId: string;
  firmwareVersion: string;
  slotCount: number;
  status1: number;
  status2: number;
  status3: number;
  slots: StandardizedSlotInfo[];
  checksum?: string;
}

export class StatusCommand {
  constructor(private serialService: SerialService) {}

  async execute(): Promise<void> {
    // Send CQ command: {0@CQ,0,0,0000}
    const command = "{0@CQ,0,0,0000}";
    const response = await this.serialService.sendCommand(command);

    // Parse the response frame
    const frameContent = response.slice(1, -1); // Remove { and }
    const parts = frameContent.split("@");

    if (parts.length !== 2) {
      throw new Error("Invalid response format");
    }

    const commandAndData = parts[1];
    const fields = commandAndData.split(",");

    if (fields[0] === "AC") {
      // This is an AC response - parse it
      const dataString = fields.slice(1).join(",");
      const dataBuffer = Buffer.from(dataString, "ascii");

      // Add leading null byte as seen in actual responses
      const fullBuffer = Buffer.alloc(dataBuffer.length + 1);
      fullBuffer.writeUInt8(0, 0);
      dataBuffer.copy(fullBuffer, 1);

      const parsed = parseACResponse(fullBuffer);

      if (parsed) {
        // Convert to standardized format (matching S1TTXX format)
        const standardizedResponse: StandardizedQueryResponse = {
          messageId: parsed.messageId,
          deviceId: parsed.deviceId,
          firmwareVersion: parsed.firmwareVersion,
          slotCount: parsed.slotCount,
          status1: parsed.status1,
          status2: parsed.status2,
          status3: parsed.status3,
          slots: parsed.slots.map((slot) => {
            const standardizedStatus = convertSlotStatusToStandardized(
              slot.status,
              slot.serialNumber
            );

            return {
              slotNumber: slot.slotNumber,
              powerBank:
                slot.serialNumber !== null
                  ? {
                      id: slot.serialNumber,
                      powerLevel: slot.powerLevel,
                    }
                  : null,
              available: standardizedStatus.available,
              charging: standardizedStatus.charging,
              outputting: standardizedStatus.outputting,
            };
          }),
          checksum: parsed.checksum,
        };

        console.log(JSON.stringify(standardizedResponse, null, 2));
      } else {
        console.log("Raw response:", response);
      }
    } else {
      console.log("Response:", response);
    }
  }
}
