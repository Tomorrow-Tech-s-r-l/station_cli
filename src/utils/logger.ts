import * as fs from "fs";
import * as path from "path";

class Logger {
  private logStream: fs.WriteStream | null = null;
  private logFilePath: string | null = null;
  private isLoggingEnabled: boolean = false;

  /**
   * Initialize logging to file with timestamp
   */
  public enableFileLogging(): void {
    if (this.isLoggingEnabled) {
      return;
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\..+/, ""); // Format: 2025-10-08T14-30-45

    this.logFilePath = path.join(process.cwd(), `${timestamp}-cli-logs.log`);

    try {
      this.logStream = fs.createWriteStream(this.logFilePath, { flags: "a" });
      this.isLoggingEnabled = true;

      // Write header to log file
      this.writeToFile(
        `=== CLI Log Started at ${new Date().toISOString()} ===\n`
      );
    } catch (error) {
      console.error("Failed to create log file:", error);
    }
  }

  /**
   * Write to log file only (not to console)
   */
  private writeToFile(message: string): void {
    if (this.isLoggingEnabled && this.logStream) {
      this.logStream.write(message);
    }
  }

  /**
   * Log message to console and optionally to file
   */
  public log(...args: any[]): void {
    const message = args
      .map((arg) =>
        typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
      )
      .join(" ");

    console.log(...args);

    if (this.isLoggingEnabled) {
      this.writeToFile(`[LOG] ${new Date().toISOString()} - ${message}\n`);
    }
  }

  /**
   * Log error message to console and optionally to file
   */
  public error(...args: any[]): void {
    const message = args
      .map((arg) =>
        typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
      )
      .join(" ");

    console.error(...args);

    if (this.isLoggingEnabled) {
      this.writeToFile(`[ERROR] ${new Date().toISOString()} - ${message}\n`);
    }
  }

  /**
   * Close the log file stream
   */
  public close(): void {
    if (this.logStream) {
      this.writeToFile(
        `=== CLI Log Ended at ${new Date().toISOString()} ===\n\n`
      );
      this.logStream.end();
      this.logStream = null;
      this.isLoggingEnabled = false;
    }
  }

  /**
   * Get the log file path
   */
  public getLogFilePath(): string | null {
    return this.logFilePath;
  }

  /**
   * Check if logging is enabled
   */
  public isLogging(): boolean {
    return this.isLoggingEnabled;
  }
}

// Export a singleton instance
export const logger = new Logger();
