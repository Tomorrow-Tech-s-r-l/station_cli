import { SerialService } from "../../services/serial";
import { DualPortSerialService } from "../../services/dual_port_serial";
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

export class SlotsCommand {
  constructor(
    private serialService: SerialService | DualPortSerialService
  ) {}

  private async querySingleBoard(
    service: SerialService
  ): Promise<StandardizedQueryResponse | null> {
    // Send CQ command: {0@CQ,0,0,0000}
    const command = "{0@CQ,0,0,0000}";
    const response = await service.sendCommand(command);

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
          deviceId: parsed.deviceId,
          firmwareVersion: parsed.firmwareVersion,
          slotCount: parsed.slotCount,
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
              isPowerbankPresent: slot.fillStatus === 1,
              available: standardizedStatus.available,
              charging: standardizedStatus.charging,
            };
          }),
          checksum: parsed.checksum,
        };

        return standardizedResponse;
      }
    }
    return null;
  }

  private isDualPortService(
    service: SerialService | DualPortSerialService
  ): service is DualPortSerialService {
    return (
      service instanceof DualPortSerialService ||
      typeof (service as any).getBoard0Service === "function"
    );
  }

  async execute(): Promise<void> {
    // Check if this is a dual-port service (S0RU30)
    if (this.isDualPortService(this.serialService)) {
      // Query both boards in parallel
      const [board0Response, board1Response] = await Promise.all([
        this.querySingleBoard(this.serialService.getBoard0Service()),
        this.querySingleBoard(this.serialService.getBoard1Service()),
      ]);

      // Merge responses
      const allSlots: StandardizedSlotInfo[] = [];

      // Add board 0 slots (1-18) - keep original slot numbers
      if (board0Response) {
        allSlots.push(...board0Response.slots);
      }

      // Add board 1 slots (19-30) - map local slot numbers (1-12) to global (19-30)
      if (board1Response) {
        const board1Slots = board1Response.slots.map((slot) => ({
          ...slot,
          slotNumber: slot.slotNumber + 18, // Map 1-12 to 19-30
        }));
        allSlots.push(...board1Slots);
      }

      // Create merged response
      const mergedResponse: StandardizedQueryResponse = {
        deviceId: board0Response?.deviceId || board1Response?.deviceId || "",
        firmwareVersion:
          board0Response?.firmwareVersion || board1Response?.firmwareVersion || "",
        slotCount: 30, // S0RU30 has 30 slots total
        slots: allSlots.sort((a, b) => a.slotNumber - b.slotNumber), // Sort by slot number
      };

      console.log(JSON.stringify(mergedResponse, null, 2));
    } else {
      // Single board (S0RU6) - use existing logic
      const response = await this.querySingleBoard(this.serialService);
      if (response) {
        console.log(JSON.stringify(response, null, 2));
      } else {
        console.log("Failed to parse response");
      }
    }
  }
}
