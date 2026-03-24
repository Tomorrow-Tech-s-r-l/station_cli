import { SerialService } from "./serial";
import { debug } from "../../utils/debug";

/**
 * Dual-port serial service for S0RU30 model.
 * Manages two serial connections:
 * - Board 0: handles slots 1-18
 * - Board 1: handles slots 19-30
 */
export class DualPortSerialService {
  private board0Service: SerialService;
  private board1Service: SerialService;

  constructor(private port0Path: string, private port1Path: string) {
    debug.info(
      `Initializing DualPortSerialService (S0RU30) with ports: ${port0Path}, ${port1Path}`
    );
    this.board0Service = new SerialService(port0Path);
    this.board1Service = new SerialService(port1Path);
  }

  async connect(): Promise<void> {
    debug.info("Connecting to both boards...");
    await Promise.all([
      this.board0Service.connect(),
      this.board1Service.connect(),
    ]);
    debug.success("Both boards connected successfully");
  }

  async disconnect(): Promise<void> {
    debug.info("Disconnecting from both boards...");
    await Promise.all([
      this.board0Service.disconnect(),
      this.board1Service.disconnect(),
    ]);
    debug.success("Both boards disconnected");
  }

  /**
   * Determines which board (0 or 1) handles the given slot index.
   * Board 0: slots 1-18
   * Board 1: slots 19-30
   */
  static getBoardForSlot(slotIndex: number): 0 | 1 {
    if (slotIndex >= 1 && slotIndex <= 18) {
      return 0;
    } else if (slotIndex >= 19 && slotIndex <= 30) {
      return 1;
    } else {
      throw new Error(`Invalid slot index: ${slotIndex}. Must be between 1 and 30.`);
    }
  }

  /**
   * Maps global slot index (1-30) to local board slot index.
   * Board 0: 1-18 maps to 1-18
   * Board 1: 19-30 maps to 1-12
   */
  static mapToLocalSlotIndex(slotIndex: number): number {
    const board = DualPortSerialService.getBoardForSlot(slotIndex);
    if (board === 0) {
      return slotIndex; // 1-18 stays 1-18
    } else {
      return slotIndex - 18; // 19-30 becomes 1-12
    }
  }

  /**
   * Sends a command to the appropriate board based on slot index.
   * Returns the service for the board handling the slot.
   */
  getServiceForSlot(slotIndex: number): SerialService {
    const board = DualPortSerialService.getBoardForSlot(slotIndex);
    return board === 0 ? this.board0Service : this.board1Service;
  }

  /**
   * Gets the service for board 0 (slots 1-18)
   */
  getBoard0Service(): SerialService {
    return this.board0Service;
  }

  /**
   * Gets the service for board 1 (slots 19-30)
   */
  getBoard1Service(): SerialService {
    return this.board1Service;
  }
}
