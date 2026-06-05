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
export const CMD_SET_INFO_PWB = 0x08;
export const CMD_SET_INFO_BATTERY = 0x09;
export const CMD_PB_FW_VER_CODE = 0x0a;

// Powerbank firmware-update opcodes (see NF-260513-bootloader.md and the
// powerbank firmware App/Inc/fwu_iface.h — single source of truth on the
// firmware side). These are slot-routed: the station uses the slot byte
// to pick the pogo line and forwards the rest opaquely. PB_ENTER_BOOT is
// served by the powerbank app and triggers a reset into the bootloader;
// PB_FWU_* are served by the powerbank bootloader. Phase 3 wires HELLO
// and EXIT; BEGIN/DATA/END/ABORT land in Phase 4.
export const CMD_PB_ENTER_BOOT_CODE = 0x10;
export const CMD_PB_FWU_HELLO_CODE  = 0x11;
export const CMD_PB_FWU_BEGIN_CODE  = 0x12;
export const CMD_PB_FWU_DATA_CODE   = 0x13;
export const CMD_PB_FWU_END_CODE    = 0x14;
export const CMD_PB_FWU_ABORT_CODE  = 0x15;
export const CMD_PB_FWU_EXIT_CODE   = 0x16;

export const CMD_GET_FW_VER = 0x50;
export const CMD_PB_LINK_STATS = 0x51;
export const CMD_STATS = 0x52;

// Station-side firmware-update opcodes (CMD_FWU_*, no PB_ prefix — these
// target the station board itself, no slot routing). FWU_ENTER is served
// by the running Zephyr application: it writes the rendezvous magic and
// calls sys_reboot() so the next boot lands in the bootloader. The other
// six are served by the in-application bootloader, which speaks the same
// addressed RS-485 framing as the app (SOF 0xEA, board address, payload,
// CRC16-Modbus).
//
// Note: the current firmware (MCUboot serial-recovery) only implements
// FWU_ENTER on the station side — the rest of the upload is handled by
// the standard mcumgr SMP protocol after the reboot. The HELLO/BEGIN/DATA/
// END/ABORT/EXIT codes are reserved for the custom-bootloader pivot path
// (mirrors the powerbank FWU family, no slot byte).
export const CMD_FWU_ENTER_CODE = 0x60;
export const CMD_FWU_HELLO_CODE = 0x61;
export const CMD_FWU_BEGIN_CODE = 0x62;
export const CMD_FWU_DATA_CODE  = 0x63;
export const CMD_FWU_END_CODE   = 0x64;
export const CMD_FWU_ABORT_CODE = 0x65;
export const CMD_FWU_EXIT_CODE  = 0x66;

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

// Pack voltage (mV) at/under which the kiosk flags a "low voltage issue" on
// the battery. Matches BATTERY_V_CUTOFF in
// firmware/P1TT2C-firmware/App/Inc/config.h. A pack flagged low-voltage that is
// in PB_STATUS_CUTOFF is skipped by the `slots` auto-charge logic (it only
// charges plugged-in packs); the operator recovers it with `charge -i N -e true`.
export const LOW_VOLTAGE_THRESHOLD_MV = 12000;

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
