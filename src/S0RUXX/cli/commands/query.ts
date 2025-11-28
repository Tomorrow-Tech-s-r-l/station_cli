import { SerialService } from "../../services/serial";
import { parseACResponse } from "../../utils/response_parser";

export class QueryCommand {
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
        console.log(JSON.stringify(parsed, null, 2));
      } else {
        console.log("Raw response:", response);
      }
    } else {
      console.log("Response:", response);
    }
  }
}
