import { SerialService } from "../services/serial";
import { SlotsCommand } from "../cli/commands/slots";
import { StatusCommand } from "../cli/commands/status";
import { PbFirmwareCommand } from "../cli/commands/pb_firmware";
import { mapBoardToSlot } from "../utils/slot_mapping";
import { calculatePowerLevel, isLowVoltage } from "../utils/power_level";
import {
  CMD_GET_FW_VER,
  MINIMUM_BOARD_ADDRESS,
  PB_STATUS_CHARGING,
  SLOT_LOCKED,
} from "../../utils/constants";
import { getMaximumBoardAddress } from "../../utils/model";
import { parseVersion } from "./version";
import { InstalledTarget, SlotCondition } from "./types";
import { FwuWire } from "./session/wire";
import { powerbankTarget, stationTarget } from "./session/target";

/**
 * Reads what is actually installed and what physical condition each slot is
 * in. Everything here uses existing, non-disruptive commands — no device is
 * reset and no bootloader is entered — so an inventory is safe to run at any
 * time, including while the station is serving customers.
 */

const SLOTS_PER_BOARD = 6;

export interface InventoryFilter {
  /** Board addresses to look at. Empty/undefined means every board. */
  boards?: number[];
  /** 1-based slot indices to look at. Empty/undefined means every slot. */
  slots?: number[];
  /** Skip the per-slot powerbank walk entirely. */
  skipPowerbanks?: boolean;
  /** Skip the per-board interface walk entirely. */
  skipInterfaces?: boolean;
}

export interface Inventory {
  interfaces: InstalledTarget[];
  powerbanks: InstalledTarget[];
  warnings: string[];
}

/** Every board address valid for the active station model. */
export function allBoardAddresses(): number[] {
  const out: number[] = [];
  for (let b = MINIMUM_BOARD_ADDRESS; b <= getMaximumBoardAddress(); b++) {
    out.push(b);
  }
  return out;
}

/**
 * Walks the station and reports installed firmware for every interface board
 * and every docked powerbank.
 *
 * A board that does not answer is reported with `reachable: false` rather than
 * failing the run: on a partly populated station (an S1TT30 cabinet with a
 * board removed for service) the remaining boards must still be updatable.
 */
export async function collectInventory(
  service: SerialService,
  filter: InventoryFilter = {}
): Promise<Inventory> {
  const warnings: string[] = [];
  const interfaces: InstalledTarget[] = [];
  const powerbanks: InstalledTarget[] = [];

  const boardFilter = filter.boards && filter.boards.length ? new Set(filter.boards) : null;
  const slotFilter = filter.slots && filter.slots.length ? new Set(filter.slots) : null;

  const boards = allBoardAddresses().filter((b) => !boardFilter || boardFilter.has(b));

  for (const boardAddress of boards) {
    if (!filter.skipInterfaces) {
      interfaces.push(await readInterfaceVersion(service, boardAddress));
    }

    if (filter.skipPowerbanks) continue;

    // One `slots` call covers the board's six slots, so occupancy costs a
    // single frame per board rather than one per slot.
    const condition = await readSlotConditions(service, boardAddress, warnings);
    if (!condition) continue;

    for (let slotInBoard = 0; slotInBoard < SLOTS_PER_BOARD; slotInBoard++) {
      let slotIndex: number;
      try {
        slotIndex = mapBoardToSlot(boardAddress, slotInBoard);
      } catch {
        continue; // slot beyond this model's range
      }
      if (slotFilter && !slotFilter.has(slotIndex)) continue;

      const slot = condition[slotInBoard];
      const target: InstalledTarget = {
        kind: "powerbank",
        boardAddress,
        slotIndex,
        name: null,
        versionRaw: null,
        version: null,
        status: -1,
        reachable: false,
        slot,
        error: null,
      };

      // An empty slot has nothing to interrogate — record it and move on so
      // the planner can report SLOT_EMPTY instead of a bogus read failure.
      if (!slot.present) {
        target.error = "No powerbank in slot";
        powerbanks.push(target);
        continue;
      }

      await enrichWithPackStatus(service, boardAddress, slotInBoard, target);
      await enrichWithPackVersion(service, boardAddress, slotInBoard, target);
      powerbanks.push(target);
    }
  }

  return { interfaces, powerbanks, warnings };
}

/**
 * Reads one interface board's application firmware version via CMD_GET_FW_VER.
 *
 * The frame layout matches the existing `firmware` command: the board writes
 * its FW_VERSION string verbatim into the payload, with no length prefix and
 * no guaranteed NUL terminator, so trailing NULs are stripped by hand.
 */
export async function readInterfaceVersion(
  service: SerialService,
  boardAddress: number
): Promise<InstalledTarget> {
  const target: InstalledTarget = {
    kind: "interface",
    boardAddress,
    slotIndex: null,
    name: "S1TTXX-firmware",
    versionRaw: null,
    version: null,
    status: -1,
    reachable: false,
    error: null,
  };

  try {
    const response = await service.sendMessage({
      boardAddress,
      command: CMD_GET_FW_VER,
    });
    target.status = response[2];
    const ok = response[2] === 0 && response.length > 3;
    if (!ok) {
      target.error = `Board did not return a version (status ${response[2]})`;
      await probeBootloader(new FwuWire(service, stationTarget(boardAddress)), target);
      return target;
    }
    target.reachable = true;
    target.versionRaw = response.subarray(3).toString("utf8").replace(/\0+$/, "").trim();
    target.version = parseVersion(target.versionRaw);
    if (!target.version) {
      target.error = `Unparseable version string "${target.versionRaw}"`;
    }
  } catch (e) {
    target.error = e instanceof Error ? e.message : String(e);
    await probeBootloader(new FwuWire(service, stationTarget(boardAddress)), target);
  }

  return target;
}

/**
 * Asks whether a bootloader is answering where the application is silent.
 *
 * HELLO is harmless to send to a running application — it is an unknown
 * opcode there and simply rejected — and it changes nothing in a bootloader.
 * A yes means the device has no valid application (the state an interrupted
 * flash leaves behind) and can be recovered by flashing it (F13); without this
 * probe it would be reported unreachable, run after run, forever.
 */
async function probeBootloader(wire: FwuWire, target: InstalledTarget): Promise<void> {
  try {
    const hello = await wire.hello();
    if (hello.success && hello.data.length > 0) {
      target.inBootloader = true;
      target.error = "application not running; bootloader answering (no valid application)";
    }
  } catch {
    // no bootloader either: genuinely unreachable
  }
}

/**
 * Re-reads one docked pack's physical condition, using exactly the same reads
 * the inventory used: occupancy and retention from SLOTS, then charge, voltage
 * and serial from STATUS.
 *
 * The engine calls this immediately before flashing a pack, because the plan
 * was built minutes earlier and a customer may have taken the pack or returned
 * a different one since. Returns null when the board does not answer.
 */
export async function readPowerbankCondition(
  service: SerialService,
  boardAddress: number,
  slotInBoard: number
): Promise<SlotCondition | null> {
  const conditions = await readSlotConditions(service, boardAddress, []);
  if (!conditions) return null;
  const slot = { ...conditions[slotInBoard] };
  if (!slot.present) return slot;
  const probe: InstalledTarget = {
    kind: "powerbank",
    boardAddress,
    slotIndex: null,
    name: null,
    versionRaw: null,
    version: null,
    status: -1,
    reachable: false,
    slot,
    error: null,
  };
  await enrichWithPackStatus(service, boardAddress, slotInBoard, probe);
  return probe.slot ?? slot;
}

/**
 * Reads occupancy and retention for a board's six slots.
 *
 * Returns null when the board does not answer; the caller treats that as "no
 * powerbanks visible here" rather than aborting the inventory.
 */
async function readSlotConditions(
  service: SerialService,
  boardAddress: number,
  warnings: string[]
): Promise<SlotCondition[] | null> {
  try {
    const response = await new SlotsCommand(service).execute(boardAddress);
    if (!response.success) {
      warnings.push(
        `Board ${boardAddress} did not answer SLOTS (status ${response.status}) — its powerbanks are not visible this run.`
      );
      return null;
    }
    const info = JSON.parse(response.data.toString()) as {
      filledSlots: number[];
      lockedSlots: number[];
    };
    return Array.from({ length: SLOTS_PER_BOARD }, (_, i) => ({
      present: info.filledSlots[i] === 1,
      // `SLOT_LOCKED` is 0: the bit is clear while the pack is retained. Same
      // reading the `status` command applies when deciding availability.
      locked: info.lockedSlots[i] === SLOT_LOCKED,
      powerLevel: null,
      charging: false,
      lowVoltage: false,
      powerbankId: null,
    }));
  } catch (e) {
    warnings.push(
      `Board ${boardAddress} SLOTS read threw: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

/** Fills state-of-charge, charging and low-voltage flags for a docked pack. */
async function enrichWithPackStatus(
  service: SerialService,
  boardAddress: number,
  slotInBoard: number,
  target: InstalledTarget
): Promise<void> {
  if (!target.slot) return;
  try {
    const r = await new StatusCommand(service).execute(boardAddress, slotInBoard);
    if (!r.success) return;
    const info = JSON.parse(r.data.toString());
    const packVoltageMv = info?.packVoltageMv ?? 0;
    target.slot.powerLevel = calculatePowerLevel(
      info?.currentCharge,
      info?.totalCharge,
      info?.cutoffCharge,
      info?.avgCapacity,
      info?.status
    );
    target.slot.charging = info?.status === PB_STATUS_CHARGING;
    target.slot.lowVoltage = isLowVoltage(info?.status, packVoltageMv);
    target.slot.powerbankId = info?.serial ?? null;
  } catch {
    // Leave powerLevel null — the planner reports BATTERY_UNKNOWN and skips.
  }
}

/** Reads a docked pack's running application version (non-disruptive). */
async function enrichWithPackVersion(
  service: SerialService,
  boardAddress: number,
  slotInBoard: number,
  target: InstalledTarget
): Promise<void> {
  try {
    const r = await new PbFirmwareCommand(service).execute(boardAddress, slotInBoard);
    target.status = r.status;
    if (!r.success || !r.info) {
      target.error = `Powerbank did not return a version (status ${r.status})`;
      await probeBootloader(new FwuWire(service, powerbankTarget(boardAddress, slotInBoard)), target);
      return;
    }
    target.reachable = true;
    target.name = r.info.name || null;
    target.versionRaw = (r.info.version || "").trim();
    target.version = parseVersion(target.versionRaw);
    if (!target.version) {
      target.error = `Unparseable version string "${target.versionRaw}"`;
    }
  } catch (e) {
    target.error = e instanceof Error ? e.message : String(e);
  }
}
