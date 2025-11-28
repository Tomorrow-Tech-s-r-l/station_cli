import { SerialService } from "../../services/serial";

export class UnlockCommand {
  private static lastTimestamp: number = 0;
  
  constructor(private serialService: SerialService) {}

  async execute(): Promise<void> {
    // Generate incrementing value using timestamp (milliseconds since epoch)
    // Ensure X is always increased, even if called multiple times in the same millisecond
    let timestamp = Date.now();
    
    // If timestamp is same or less than last one (shouldn't happen, but safety check),
    // increment it to ensure it's always increasing
    if (timestamp <= UnlockCommand.lastTimestamp) {
      timestamp = UnlockCommand.lastTimestamp + 1;
    }
    
    UnlockCommand.lastTimestamp = timestamp;
    
    // Send FB unlock command: {0@FB,0,X,1,0000} where X is the incrementing timestamp
    // Note: This command doesn't return a response
    const command = `{0@FB,0,${timestamp},1,0000}`;
    console.log(`Sending unlock command with timestamp: ${timestamp}`);
    await this.serialService.sendCommandNoResponse(command);
    console.log("Unlock command sent successfully");
  }
}
