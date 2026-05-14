// Protocol Constants
export const FRAME_START_BYTE = 0xea;
export const BAUD_RATE = 115200;
export const CRC_ALGORITHM = "MODBUS";
export const INTER_COMMAND_DELAY_MS = 50;
export const FRAME_START_CHAR = "{";
export const FRAME_END_CHAR = "}";

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
export const CMD_PB_FW_VER_CODE = 0x0a;

// Firmware-update opcodes (see NF-260513-bootloader.md and
// firmware App/Inc/fwu_iface.h — single source of truth on the firmware side).
// CMD_ENTER_BOOT is handled by the application and triggers a reset into
// the bootloader; the rest are answered by the bootloader. Phase 3 wires
// up HELLO and EXIT; BEGIN/DATA/END/ABORT land in Phase 4.
export const CMD_ENTER_BOOT_CODE = 0x10;
export const CMD_FWU_HELLO_CODE = 0x11;
export const CMD_FWU_BEGIN_CODE = 0x12;
export const CMD_FWU_DATA_CODE = 0x13;
export const CMD_FWU_END_CODE = 0x14;
export const CMD_FWU_ABORT_CODE = 0x15;
export const CMD_FWU_EXIT_CODE = 0x16;

export const CMD_GET_FW_VER = 0x50;
export const CMD_PB_LINK_STATS = 0x51;
export const CMD_STATS = 0x52;

// Station-side firmware-update opcodes — bootloader/Inc/fwu_iface.h on the
// firmware side is the single source of truth. ENTER is handled by the
// running Zephyr application (it writes the rendezvous magic and calls
// sys_reboot). The other six are handled by the in-application bootloader
// itself, which speaks the same addressed RS-485 framing as the app
// (SOF 0xEA, board address, payload, CRC16-Modbus). Unlike the powerbank
// CMD_FWU_* family these do NOT carry a slot index — they target the
// station board itself, not a powerbank slot.
export const CMD_STATION_FWU_ENTER_CODE = 0x60;
export const CMD_STATION_FWU_HELLO_CODE = 0x61;
export const CMD_STATION_FWU_BEGIN_CODE = 0x62;
export const CMD_STATION_FWU_DATA_CODE  = 0x63;
export const CMD_STATION_FWU_END_CODE   = 0x64;
export const CMD_STATION_FWU_ABORT_CODE = 0x65;
export const CMD_STATION_FWU_EXIT_CODE  = 0x66;

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

export const SLOT_INDEX_MAXIMUM_S1TT6 = 6;
export const SLOT_INDEX_MAXIMUM_S0RU6 = 6;
export const SLOT_INDEX_MAXIMUM_S0RU30 = 30;
export const SLOT_INDEX_MAXIMUM_S1TT30 = 30;

// Powerbank Status
export const PB_STATUS_IDLE = 1;
export const PB_STATUS_PLUGGED_IN = 2;
export const PB_STATUS_CHARGING = 3;
export const PB_STATUS_DISCHARGING = 4;
export const PB_STATUS_CUTOFF = 5;

// Limits
export const MINIMUM_BOARD_ADDRESS = 0;
export const MAXIMUM_BOARD_ADDRESS_S0RU6 = 0;
export const MAXIMUM_BOARD_ADDRESS_S0RU30 = 1; // Two boards: 0 and 1

export const MAXIMUM_BOARD_ADDRESS_S1TT6 = 0;
export const MAXIMUM_BOARD_ADDRESS_S1TT30 = 4;

export const MAXIMUM_SLOT_ADDRESS = 5;
export const MINIMUM_POWER_LEVEL = 0;
export const MAXIMUM_POWER_LEVEL = 100;
export const MAXIMUM_POWERBANK_TO_CHARGE_PER_BOARD = 1;

// LED Colors
export const LED_COLOR_RED = 0;
export const LED_COLOR_GREEN = 1;
export const LED_COLOR_BLUE = 2;
