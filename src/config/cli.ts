import { Command } from "commander";

import { logger } from "../utils/logger";
import { loadConfig, printableConfig } from "./loader";
import { CONFIG_JSON_SCHEMA, effectiveLockFile } from "./schema";

/**
 * `station-cli config check` — prints the effective configuration, which
 * layers produced it, and anything wrong with it. The first thing to run when
 * a station is not doing what you expect.
 *
 * `station-cli config schema` — prints the JSON Schema for the document, for
 * editors and for callers that want to validate before invoking the CLI.
 *
 * Credentials are shown only as present or absent. That is guaranteed by
 * construction (`Secret`), not by filtering this output.
 */
export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Inspect the layered configuration");

  config
    .command("check")
    .description("Show the effective configuration, the layers it came from, and any problems")
    .option("--config <path>", "Also read this JSON file (layer 5)")
    .option("--config-stdin", "Also read configuration JSON from stdin (layer 6)")
    .action(async (opts: { config?: string; configStdin?: boolean }) => {
      const loaded = await loadConfig({
        configPath: opts.config,
        configStdin: opts.configStdin === true,
      });
      const fw = loaded.config.firmware;
      const out = {
        success: loaded.errors.length === 0,
        layers: loaded.layers,
        effective: printableConfig(loaded.config),
        derived: {
          lockFile: effectiveLockFile(fw),
          firmwareSources: {
            interface: fw.sources.interface?.repo ?? null,
            powerbank: fw.sources.powerbank?.repo ?? null,
          },
          credentialPresent: loaded.config.credentials.github.token !== null,
        },
        warnings: loaded.warnings,
        errors: loaded.errors,
      };
      logger.log(JSON.stringify(out, null, 2));

      const hints: string[] = [];
      if (!fw.sources.interface || !fw.sources.powerbank) {
        hints.push(
          "no firmware source for " +
            [!fw.sources.interface && "interface", !fw.sources.powerbank && "powerbank"]
              .filter(Boolean)
              .join(" or ") +
            ' devices: add firmware.sources.<kind> = {"provider":"github","repo":"owner/name"}'
        );
      }
      if (!loaded.config.credentials.github.token) {
        hints.push(
          "no GitHub credential: private firmware repositories will be unreadable " +
            "(pipe {\"credentials\":{\"github\":{\"token\":\"…\"}}} to --config-stdin, or set STATION_CLI_GITHUB_TOKEN)"
        );
      }
      if (hints.length) process.stderr.write(hints.map((h) => `hint: ${h}`).join("\n") + "\n");
      if (loaded.errors.length) process.exit(1);
    });

  config
    .command("schema")
    .description("Print the JSON Schema of the configuration document")
    .action(() => {
      logger.log(JSON.stringify(CONFIG_JSON_SCHEMA, null, 2));
    });
}
