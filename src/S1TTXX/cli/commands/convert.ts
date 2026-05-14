import { crc16 } from "easy-crc";
import {
  FRAME_START_BYTE,
  CRC_ALGORITHM,
  STATUS_OK,
} from "../../../utils/constants";
import {
  CMD_STATUS_CODE,
  CMD_SET_CHARGE_CODE,
  CMD_RESET_CODE,
  CMD_SET_PDO_CODE,
  CMD_SLOTS_CODE,
  CMD_UNLOCK_CODE,
  CMD_SET_LED_CODE,
  CMD_SET_INFO_PWB,
  CMD_SET_INFO_BATTERY,
  CMD_GET_FW_VER,
} from "../../../utils/constants";

/**
 * Get command name from command code
 */
function getCommandName(commandCode: number): string {
  const commandNames: { [key: number]: string } = {
    [CMD_STATUS_CODE]: "STATUS",
    [CMD_SET_CHARGE_CODE]: "SET_CHARGE",
    [CMD_RESET_CODE]: "RESET",
    [CMD_SET_PDO_CODE]: "SET_PDO",
    [CMD_SLOTS_CODE]: "SLOTS",
    [CMD_UNLOCK_CODE]: "UNLOCK",
    [CMD_SET_LED_CODE]: "SET_LED",
    [CMD_SET_INFO_PWB]: "SET_INFO_PWB",
    [CMD_SET_INFO_BATTERY]: "SET_INFO_BATTERY",
    [CMD_GET_FW_VER]: "GET_FW_VER",
  };
  return (
    commandNames[commandCode] ||
    `UNKNOWN(0x${commandCode.toString(16).padStart(2, "0")})`
  );
}

/**
 * Get command description
 */
function getCommandDescription(commandCode: number): string {
  const descriptions: { [key: number]: string } = {
    [CMD_STATUS_CODE]: "Get powerbank status in a specific slot",
    [CMD_SET_CHARGE_CODE]: "Enable/disable charging for a powerbank",
    [CMD_RESET_CODE]: "Reset a powerbank",
    [CMD_SET_PDO_CODE]: "Set charging profile (voltage/current)",
    [CMD_SLOTS_CODE]: "Get status of all slots on the board",
    [CMD_UNLOCK_CODE]: "Unlock a powerbank from its slot",
    [CMD_SET_LED_CODE]: "Control LED indicator for a slot",
    [CMD_SET_INFO_PWB]: "Initialize powerbank information",
    [CMD_SET_INFO_BATTERY]: "Set battery information",
    [CMD_GET_FW_VER]: "Get firmware version",
  };
  return descriptions[commandCode] || "Unknown command";
}

/**
 * Get expected response format
 */
function getExpectedResponseFormat(commandCode: number): string {
  const formats: { [key: number]: string } = {
    [CMD_STATUS_CODE]:
      "Response: <cmd> <status> <serial(10)> <manufTs(4)> <totalCharge(2)> <currentCharge(2)> <cutoffCharge(2)> <cycles(2)> <pbStatus(1)>",
    [CMD_SET_CHARGE_CODE]:
      "Response: <cmd> <status> (status: 0x00=OK, 0x01=timeout, 0x02=invalid_cmd, 0x03=invalid_args, 0x04=internal_error)",
    [CMD_RESET_CODE]:
      "Response: <cmd> <status> (status: 0x00=OK, 0x01=timeout, 0x02=invalid_cmd, 0x03=invalid_args, 0x04=internal_error)",
    [CMD_SET_PDO_CODE]:
      "Response: <cmd> <status> (status: 0x00=OK, 0x01=timeout, 0x02=invalid_cmd, 0x03=invalid_args, 0x04=internal_error)",
    [CMD_SLOTS_CODE]:
      "Response: <cmd> <status> <lockedSlots(6 bytes)> (JSON format with slot lock status)",
    [CMD_UNLOCK_CODE]:
      "Response: <cmd> <status> (status: 0x00=OK, 0x01=timeout, 0x02=invalid_cmd, 0x03=invalid_args, 0x04=internal_error)",
    [CMD_SET_LED_CODE]:
      "Response: <cmd> <status> (status: 0x00=OK, 0x01=timeout, 0x02=invalid_cmd, 0x03=invalid_args, 0x04=internal_error)",
    [CMD_SET_INFO_PWB]:
      "Response: <cmd> <status> (status: 0x00=OK, 0x01=timeout, 0x02=invalid_cmd, 0x03=invalid_args, 0x04=internal_error)",
    [CMD_SET_INFO_BATTERY]:
      "Response: <cmd> <status> (status: 0x00=OK, 0x01=timeout, 0x02=invalid_cmd, 0x03=invalid_args, 0x04=internal_error)",
    [CMD_GET_FW_VER]: "Response: <cmd> <status> <version utf-8 string>",
  };
  return formats[commandCode] || "Unknown response format";
}

/**
 * Parse hex string input (with or without spaces)
 */
function parseHexInput(input: string): Buffer {
  // Remove spaces and convert to buffer
  const hexString = input.replace(/\s+/g, "").toLowerCase();

  // Validate hex string
  if (!/^[0-9a-f]+$/.test(hexString)) {
    throw new Error(
      "Invalid hex string. Only 0-9 and a-f characters are allowed."
    );
  }

  if (hexString.length % 2 !== 0) {
    // Check if it looks like multiple frames concatenated
    const frameStartPattern = /ea/g;
    const frameMatches = hexString.match(frameStartPattern);
    if (frameMatches && frameMatches.length > 1) {
      // Try to suggest where to split
      const frameStarts: number[] = [];
      let index = hexString.indexOf("ea");
      while (index !== -1) {
        // Only count if it's at an even position (start of a byte)
        if (index % 2 === 0) {
          frameStarts.push(index);
        }
        index = hexString.indexOf("ea", index + 1);
      }

      let suggestion = "";
      // Try to find a good split point (prefer even positions for frame starts)
      if (frameStarts.length > 1) {
        // Use the second frame start at an even position
        const splitPos = frameStarts[1];
        const firstFrame = hexString.substring(0, splitPos);
        const secondFrame = hexString.substring(splitPos);

        // Format with spaces for readability
        const formatHex = (hex: string) => {
          // Pad to even length if needed for display
          const padded = hex.length % 2 === 0 ? hex : hex + "?";
          return padded.match(/.{1,2}/g)?.join(" ") || hex;
        };

        const formatHexForCommand = (hex: string) => {
          return hex.match(/.{1,2}/g)?.join(" ") || hex;
        };

        suggestion =
          `\n\nDetected ${frameMatches.length} potential frames. ` +
          `Convert them separately:\n\n` +
          `  Frame 1: ${formatHex(firstFrame)}\n` +
          `  Command: convert ${formatHexForCommand(firstFrame)}\n\n` +
          `  Frame 2: ${formatHex(secondFrame)}\n` +
          `  Command: convert ${formatHexForCommand(secondFrame)}`;
      } else if (frameMatches.length > 1) {
        // Found multiple "ea" but not all at even positions - suggest manual splitting
        const firstEaPos = hexString.indexOf("ea");
        const secondEaPos = hexString.indexOf("ea", firstEaPos + 1);
        if (secondEaPos !== -1) {
          // Try to suggest splitting at the second "ea" position
          const firstFrame = hexString.substring(0, secondEaPos);
          const secondFrame = hexString.substring(secondEaPos);

          const formatHexForCommand = (hex: string) => {
            return hex.match(/.{1,2}/g)?.join(" ") || hex;
          };

          suggestion =
            `\n\nDetected ${frameMatches.length} occurrences of "ea". ` +
            `The frames appear to be concatenated. Try:\n\n` +
            `  Frame 1: convert ${formatHexForCommand(firstFrame)}\n` +
            `  Frame 2: convert ${formatHexForCommand(secondFrame)}`;
        }
      }

      throw new Error(
        `Hex string has odd number of characters (${hexString.length}). ` +
          `Detected ${frameMatches.length} occurrences of frame start byte (0xEA). ` +
          `Please provide only one complete frame at a time.${suggestion}`
      );
    }
    // Provide helpful suggestions based on frame structure
    let suggestion = "";
    const minFrameLength = 4; // SF (1) + address (1) + command (1) + CRC (2) = 5 bytes = 10 hex chars

    if (hexString.length >= minFrameLength) {
      // Check if it starts with frame start byte
      if (hexString.startsWith("ea")) {
        // Try to identify what might be missing
        const expectedMinLength = 10; // Minimum complete frame: ea + addr + cmd + crc(2 bytes)
        if (hexString.length < expectedMinLength) {
          suggestion =
            `\n\nMinimum frame length is ${expectedMinLength} hex characters ` +
            `(SF + address + command + CRC). ` +
            `Your input has ${hexString.length} characters.`;
        } else {
          // Frame seems mostly complete, might be missing last CRC byte
          const missingChars = 2 - (hexString.length % 2);
          suggestion =
            `\n\nYour frame appears incomplete. ` +
            `Missing ${missingChars} hex character(s) to complete the last byte. ` +
            `CRC requires 2 bytes (4 hex characters).`;
        }
      } else {
        suggestion =
          `\n\nFrame should start with 0xEA. ` +
          `Your input starts with 0x${hexString
            .substring(0, 2)
            .toUpperCase()}.`;
      }
    } else {
      suggestion = `\n\nFrame is too short. Minimum length is ${
        minFrameLength * 2
      } hex characters.`;
    }

    throw new Error(
      `Hex string must have an even number of characters (got ${hexString.length}). ` +
        `Make sure all hex bytes are complete (2 characters each). ` +
        `Missing one hex character.${suggestion}`
    );
  }

  const buffer = Buffer.from(hexString, "hex");
  return buffer;
}

/**
 * Convert frame hex input to human-readable command information
 */
export function convertFrame(input: string): void {
  try {
    const frame = parseHexInput(input);

    if (frame.length < 4) {
      console.error(
        "Error: Frame too short. Minimum length is 4 bytes (SF + address + command + CRC)."
      );
      process.exit(1);
    }

    // Parse frame structure: <SF> <address> <payload> <CRC16>
    const startFrame = frame.readUInt8(0);

    if (startFrame !== FRAME_START_BYTE) {
      console.error(
        `Error: Invalid start frame. Expected 0x${FRAME_START_BYTE.toString(
          16
        ).padStart(2, "0")}, got 0x${startFrame.toString(16).padStart(2, "0")}`
      );
      process.exit(1);
    }

    // Extract payload (everything between SF and CRC)
    const payload = frame.slice(1, -2);
    const receivedCrc = frame.readUInt16LE(frame.length - 2);

    if (payload.length < 1) {
      console.error(
        "Error: Payload too short. Must contain at least board address."
      );
      process.exit(1);
    }

    // Extract board address (first byte of payload)
    const boardAddress = payload.readUInt8(0);

    // Determine if this is a command or response
    // Commands: <boardAddr> <cmd> [data...]
    // Responses: <boardAddr> <cmd> <status> [data...]
    let isResponse = false;
    let commandCode: number | undefined;
    let commandData: Buffer | undefined;
    let responseStatus: number | undefined;
    let responseData: Buffer | undefined;

    if (payload.length >= 2) {
      commandCode = payload.readUInt8(1);

      // Check if this looks like a response (has status byte after command)
      // Responses typically have: <boardAddr> <cmd> <status> <data...>
      // Commands have: <boardAddr> <cmd> [data...]
      // If payload[2] is a valid status code (0x00-0x04), it's likely a response
      if (payload.length >= 3) {
        const possibleStatus = payload.readUInt8(2);
        // Status codes are 0x00-0x04, so if byte 2 is in this range, it's likely a response
        if (possibleStatus <= 0x04) {
          isResponse = true;
          responseStatus = possibleStatus;
          responseData = payload.slice(3);
        } else {
          // It's a command with data
          commandData = payload.slice(2);
        }
      }
    }

    // Calculate CRC
    const calculatedCrc = crc16(CRC_ALGORITHM, payload);
    const crcValid = receivedCrc === calculatedCrc;

    // Build converted payload information

    // Build output
    const result: any = {
      frame: {
        raw:
          frame
            .toString("hex")
            .toUpperCase()
            .match(/.{1,2}/g)
            ?.join(" ") || frame.toString("hex").toUpperCase(),
        length: frame.length,
      },
      startFrame: {
        value: `0x${startFrame.toString(16).padStart(2, "0").toUpperCase()}`,
        valid: startFrame === FRAME_START_BYTE,
      },
      boardAddress: {
        value: boardAddress,
        hex: `0x${boardAddress.toString(16).padStart(2, "0").toUpperCase()}`,
      },
      command:
        commandCode !== undefined
          ? {
              code: commandCode,
              hex: `0x${commandCode
                .toString(16)
                .padStart(2, "0")
                .toUpperCase()}`,
              name: getCommandName(commandCode),
              description: getCommandDescription(commandCode),
              expectedResponse: getExpectedResponseFormat(commandCode),
            }
          : null,
      payload: {
        raw:
          payload
            .toString("hex")
            .toUpperCase()
            .match(/.{1,2}/g)
            ?.join(" ") || payload.toString("hex").toUpperCase(),
        bytes: Array.from(payload).map(
          (b) => `0x${b.toString(16).padStart(2, "0").toUpperCase()}`
        ),
        length: payload.length,
      },
      data: commandData
        ? {
            raw:
              commandData
                .toString("hex")
                .toUpperCase()
                .match(/.{1,2}/g)
                ?.join(" ") || commandData.toString("hex").toUpperCase(),
            bytes: Array.from(commandData).map(
              (b) => `0x${b.toString(16).padStart(2, "0").toUpperCase()}`
            ),
            length: commandData.length,
            interpretation: interpretCommandData(commandCode!, commandData),
          }
        : null,
      crc: {
        received: {
          value: receivedCrc,
          hex: `0x${receivedCrc.toString(16).padStart(4, "0").toUpperCase()}`,
          bytes: [
            `0x${(receivedCrc & 0xff)
              .toString(16)
              .padStart(2, "0")
              .toUpperCase()}`,
            `0x${((receivedCrc >> 8) & 0xff)
              .toString(16)
              .padStart(2, "0")
              .toUpperCase()}`,
          ],
        },
        calculated: {
          value: calculatedCrc,
          hex: `0x${calculatedCrc.toString(16).padStart(4, "0").toUpperCase()}`,
          bytes: [
            `0x${(calculatedCrc & 0xff)
              .toString(16)
              .padStart(2, "0")
              .toUpperCase()}`,
            `0x${((calculatedCrc >> 8) & 0xff)
              .toString(16)
              .padStart(2, "0")
              .toUpperCase()}`,
          ],
        },
        valid: crcValid,
      },
      // Show the converted payload as the CLI would process it (like CommandResponse)
      convertedPayload: (() => {
        if (
          isResponse &&
          commandCode !== undefined &&
          responseData &&
          responseStatus !== undefined
        ) {
          // This is a response frame - parse it like the CLI does
          const parsed = parseResponseData(commandCode, responseData);
          const statusMessage =
            responseStatus === STATUS_OK
              ? "OK"
              : responseStatus === 0x01
              ? "TIMEOUT"
              : responseStatus === 0x02
              ? "INVALID_CMD"
              : responseStatus === 0x03
              ? "INVALID_ARGS"
              : responseStatus === 0x04
              ? "INTERNAL_ERROR"
              : "UNKNOWN";

          return {
            type: "Response",
            asCommandResponse: {
              success: responseStatus === STATUS_OK,
              status: {
                code: responseStatus,
                hex: `0x${responseStatus
                  .toString(16)
                  .padStart(2, "0")
                  .toUpperCase()}`,
                message: statusMessage,
              },
              command: {
                code: commandCode,
                name: getCommandName(commandCode),
              },
              data: {
                raw:
                  responseData
                    .toString("hex")
                    .toUpperCase()
                    .match(/.{1,2}/g)
                    ?.join(" ") || responseData.toString("hex").toUpperCase(),
                bytes: Array.from(responseData),
                length: responseData.length,
              },
              parsed: parsed ? parsed.parsed : null,
            },
          };
        } else {
          // This is a command frame - show it as a SerialMessage structure
          const serialMessage: any = {
            boardAddress: boardAddress,
            command: commandCode !== undefined ? commandCode : null,
            data: commandData
              ? {
                  raw:
                    commandData
                      .toString("hex")
                      .toUpperCase()
                      .match(/.{1,2}/g)
                      ?.join(" ") || commandData.toString("hex").toUpperCase(),
                  bytes: Array.from(commandData),
                  length: commandData.length,
                  interpretation:
                    commandCode !== undefined
                      ? interpretCommandData(commandCode, commandData)
                      : null,
                }
              : null,
          };

          // Show what the response structure would look like
          const responseFormat: any = {
            structure: "Response format: <command> <status> <data...>",
            expected: {
              command:
                commandCode !== undefined
                  ? {
                      code: commandCode,
                      name: getCommandName(commandCode),
                    }
                  : null,
              status: {
                description:
                  "Status byte (0x00=OK, 0x01=timeout, 0x02=invalid_cmd, 0x03=invalid_args, 0x04=internal_error)",
                position: "Byte 2 of response",
              },
              data: {
                description: getExpectedResponseFormat(
                  commandCode !== undefined ? commandCode : 0
                ),
                position: "Bytes 3+ of response",
              },
            },
          };

          return {
            type: "Command",
            asSerialMessage: serialMessage,
            asCommandResponse: responseFormat,
          };
        }
      })(),
    };

    console.log(JSON.stringify(result, null, 2));

    if (!crcValid) {
      console.error("\n⚠️  Warning: CRC mismatch! The frame may be corrupted.");
      process.exit(1);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    // Print error message (it already contains all the details)
    console.error(errorMessage);
    process.exit(1);
  }
}

/**
 * Parse response data like the CLI does
 */
function parseResponseData(commandCode: number, data: Buffer): any {
  switch (commandCode) {
    case CMD_SLOTS_CODE:
      if (data.length >= 2) {
        const fillByte = data.readUInt8(0);
        const lockByte = data.readUInt8(1);

        const filledSlots = Array.from(Array(6).keys()).map(
          (slotIdx) => (fillByte >> slotIdx) & 1
        );
        const lockedSlots = Array.from(Array(6).keys()).map(
          (slotIdx) => (lockByte >> slotIdx) & 1
        );

        return {
          parsed: { filledSlots, lockedSlots },
          jsonString: JSON.stringify({ filledSlots, lockedSlots }),
          buffer: `Buffer.from(JSON.stringify(${JSON.stringify({
            filledSlots,
            lockedSlots,
          })}))`,
        };
      }
      break;

    case CMD_STATUS_CODE:
      if (data.length >= 23) {
        const info = {
          serial: data
            .subarray(0, 10)
            .toString("utf8")
            .trim()
            .replace(/\0/g, ""),
          timestamp: data.readUInt32LE(10),
          totalCharge: data.readUInt16LE(14),
          currentCharge: data.readUInt16LE(16),
          cutoffCharge: data.readUInt16LE(18),
          cycles: data.readUInt16LE(20),
          status: data.readUInt8(22),
        };
        return {
          parsed: info,
          jsonString: JSON.stringify(info),
          buffer: `Buffer.from(JSON.stringify(${JSON.stringify(info)}))`,
        };
      }
      break;

    case CMD_GET_FW_VER:
      if (data.length > 0) {
        // Wire format: raw UTF-8 string (no length prefix, no NUL).
        const version = data.toString("utf8").replace(/\0+$/, "");
        return {
          parsed: { version },
          jsonString: JSON.stringify({ version }),
          buffer: `Buffer.from(JSON.stringify(${JSON.stringify({ version })}))`,
        };
      }
      break;
  }

  return null;
}

/**
 * Interpret command data based on command type
 */
function interpretCommandData(commandCode: number, data: Buffer): any {
  const interpretation: any = {};

  switch (commandCode) {
    case CMD_STATUS_CODE:
    case CMD_RESET_CODE:
    case CMD_UNLOCK_CODE:
      if (data.length >= 1) {
        interpretation.slotIndex = data.readUInt8(0);
      }
      break;

    case CMD_SET_CHARGE_CODE:
    case CMD_SET_LED_CODE:
      if (data.length >= 2) {
        interpretation.slotIndex = data.readUInt8(0);
        interpretation.param = data.readUInt8(1);
        if (commandCode === CMD_SET_CHARGE_CODE) {
          interpretation.powerLevel = data.readUInt8(1);
        } else if (commandCode === CMD_SET_LED_CODE) {
          interpretation.color = data.readUInt8(1);
          interpretation.colorName =
            ["RED", "GREEN", "BLUE"][data.readUInt8(1)] || "UNKNOWN";
        }
      }
      break;

    case CMD_SET_PDO_CODE:
      if (data.length >= 3) {
        interpretation.slotIndex = data.readUInt8(0);
        interpretation.voltage = data.readUInt8(1);
        interpretation.current = data.readUInt8(2);
      }
      break;

    case CMD_SET_INFO_PWB:
      if (data.length >= 17) {
        interpretation.slotIndex = data.readUInt8(0);
        interpretation.serialNumber = data.slice(1, 11).toString("utf8");
        interpretation.timestamp = data.readUInt32LE(11);
        interpretation.cycles = data.readUInt16LE(15);
      }
      break;

    case CMD_SET_INFO_BATTERY:
      if (data.length >= 7) {
        interpretation.slotIndex = data.readUInt8(0);
        interpretation.totalCharge = data.readUInt16LE(1);
        interpretation.currentCharge = data.readUInt16LE(3);
        interpretation.cutOffCharge = data.readUInt16LE(5);
      }
      break;

    default:
      interpretation.raw = Array.from(data)
        .map((b) => b.toString(10))
        .join(", ");
  }

  return interpretation;
}
