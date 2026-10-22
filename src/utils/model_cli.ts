import { Command, Option } from "commander";
import type { StationModel } from "./model";
import { takeFlag } from "./argv";

// Command-line handling for the station model.
//
// The model can be chosen two ways, both resolved before Commander parses
// anything (slot/board ranges in option help and validators depend on it):
//   station-cli S1TT6 status -i 3           (positional token, first argument)
//   station-cli status -i 3 --model S1TT6   (flag, anywhere before `--`)
// The positional form is what the kiosk app uses and must keep working.

export const STATION_MODELS: StationModel[] = ["S1TT30", "S1TT6", "S0TT6", "S0TT12", "S0TT18"];
export const S1TT_MODELS: StationModel[] = ["S1TT30", "S1TT6"];
export const DEFAULT_MODEL: StationModel = "S1TT30";

const MODEL_SUMMARY: Record<StationModel, string> = {
  S1TT30: "5 boards (0-4), slots 1-30 (default)",
  S1TT6: "1 board (0), slots 1-6",
  S0TT6: "S0TTXX gateway, slots 1-6 (experimental)",
  S0TT12: "S0TTXX gateway, slots 1-12 (experimental)",
  S0TT18: "S0TTXX gateway, slots 1-18 (experimental)",
};

function isStationModel(value: string): value is StationModel {
  return (STATION_MODELS as string[]).includes(value);
}

function invalidModel(value: string): Error {
  return new Error(`Unknown station model "${value}". Valid models: ${STATION_MODELS.join(", ")}`);
}

/**
 * Resolve the station model from argv and strip the model token / flag from
 * it so Commander only sees the command and its own options.
 *
 * @param argv - process.argv (mutated in place)
 * @returns the selected model, DEFAULT_MODEL when none is given
 */
export function extractModelFromArgv(argv: string[]): StationModel {
  let positional: StationModel | undefined;
  if (argv[2] !== undefined && isStationModel(argv[2])) {
    positional = argv[2];
    argv.splice(2, 1);
  }

  let flag: StationModel | undefined;
  for (const value of takeFlag(argv, "-m", "--model", `a model (${STATION_MODELS.join(", ")})`)) {
    if (!isStationModel(value)) throw invalidModel(value);
    if (flag !== undefined && flag !== value) {
      throw new Error(`Conflicting station models: ${flag} and ${value}`);
    }
    flag = value;
  }

  if (positional !== undefined && flag !== undefined && positional !== flag) {
    throw new Error(`Conflicting station models: ${positional} (first argument) and ${flag} (--model)`);
  }
  return flag ?? positional ?? DEFAULT_MODEL;
}

function modelList(models: StationModel[], indent: string): string {
  return models.map((m) => `${indent}${m.padEnd(8)}${MODEL_SUMMARY[m]}`).join("\n");
}

/** Help text appended to the top-level `--help`. */
export function programModelHelp(): string {
  return [
    "",
    "Station model:",
    "  Choose the model by giving it as the first argument or with -m/--model.",
    "  When omitted, S1TT30 is used.",
    modelList(STATION_MODELS, "    "),
    "",
    "  Examples:",
    "    station-cli S1TT6 slots",
    "    station-cli status -i 3 --model S1TT6",
    "",
    "  Commands whose slot/board ranges depend on the model show a -m, --model",
    "  option in their own help (station-cli <command> --help).",
    "",
    "Serial port:",
    "  Station commands auto-detect the port. To choose it, pass -p/--port",
    "  (e.g. --port COM3) or set STATION_CLI_PORT. \"station-cli ports\" lists",
    "  the ports and shows which one auto-detect would use.",
  ].join("\n");
}

/**
 * Document the model selection on a model-dependent command: adds a
 * `-m, --model` option (the value is consumed by extractModelFromArgv before
 * Commander parses, so this only drives `--help`) and a short help section.
 *
 * @param command - the command to annotate
 * @param models - the models the command supports
 * @param current - the model the help is being rendered for
 */
export function addModelOption(command: Command, models: StationModel[], current: StationModel): Command {
  const option = new Option(
    "-m, --model <model>",
    `Station model (default ${DEFAULT_MODEL}); same as giving it as the first argument`
  ).choices(models);
  command.addOption(option);
  command.addHelpText(
    "after",
    [
      "",
      `Station model (ranges above are for ${current}):`,
      modelList(models, "  "),
      "",
      "Examples:",
      `  station-cli ${models[1]} ${command.name()} [options]`,
      `  station-cli ${command.name()} [options] --model ${models[1]}`,
    ].join("\n")
  );
  return command;
}
