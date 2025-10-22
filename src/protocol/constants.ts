// Protocol Constants
export const FRAME_START_BYTE = 0xea;
export const BAUD_RATE = 115200;
export const CRC_ALGORITHM = "MODBUS";
export const INTER_COMMAND_DELAY_MS = 50;

// Command Codes
export const CMD_STATUS_CODE = 0x01;
export const CMD_SET_CHARGE_CODE = 0x02;
export const CMD_RESET_CODE = 0x03;
export const CMD_SET_PDO_CODE = 0x04;
export const CMD_SLOTS_CODE = 0x05;
export const CMD_UNLOCK_CODE = 0x06;
export const CMD_SET_LED_CODE = 0x07;
export const CMD_SET_INFO_PWB = 0x08;
export const CMD_SET_INFO_BATTERY = 0x09;
export const CMD_MODEL = 0x0a;
export const CMD_GET_FW_VER = 0x50;

// Status Codes
export const STATUS_OK = 0x00;
export const STATUS_TIMEOUT = 0x01;
export const STATUS_ERR_INVALID_CMD = 0x02;
export const STATUS_ERR_INVALID_ARGS = 0x03;
export const STATUS_ERR_INTERNAL = 0x04;
export const STATUS_ERR_INVALID_RESPONSE = 0x80;

// Slot Status
export const SLOT_LOCKED = 0;
export const SLOT_INDEX_MINIMUM = 1;
export const SLOT_INDEX_MAXIMUM = 30;

// Powerbank Status
export const PB_STATUS_IDLE = 1;
export const PB_STATUS_PLUGGED_IN = 2;
export const PB_STATUS_CHARGING = 3;
export const PB_STATUS_DISCHARGING = 4;
export const PB_STATUS_CUTOFF = 5;

// Limits
export const MAXIMUM_BOARD_ADDRESS = 4;
export const MAXIMUM_SLOT_ADDRESS = 5;
export const MINIMUM_POWER_LEVEL = 0;
export const MAXIMUM_POWER_LEVEL = 100;
export const MAXIMUM_POWERBANK_TO_CHARGE_PER_BOARD = 1;

// LED Colors
export const LED_COLOR_RED = 0;
export const LED_COLOR_GREEN = 1;
export const LED_COLOR_BLUE = 2;
