# Station CLI

Cross-platform CLI for managing station boards and powerbanks (S1TTXX and S0RUXX protocols).

## Quick start

Download the latest release binary, connect the station over USB, and run:

```bash
station-cli slots           # default model S1TT30
station-cli S1TT6 slots     # single-board model
```

Add `--log` to any command to save output to a timestamped file. For build-from-source steps or additional models (including S0RUXX), follow the wiki.

## Headless firmware updates

The CLI can keep a station's own hardware up to date without a person present:
the **interface boards** (S1TTXX) and the **powerbanks** (P1TT2C) docked in
them. Three commands, each printing exactly one JSON document on stdout:

```bash
station-cli fw-status     # what is installed right now (read-only, no network)
station-cli fw-plan       # + resolve releases and report what would change
station-cli fw-apply      # + flash it, verifying every device
```

Where firmware comes from, and the credential to read it, are configuration
(see [Configuration](#configuration)). A typical unattended run pipes the
credential in on stdin, where no other user on the machine can see it:

```bash
echo '{"credentials":{"github":{"token":"'"$TOKEN"'"}}}' \
  | station-cli fw-apply --config-stdin --channel stable
```

### How it decides

1. **Inventory** — reads the firmware version of every interface board
   (`CMD_GET_FW_VER`) and every docked powerbank (`CMD_PB_FW_VER`), plus each
   slot's occupancy, retention, state of charge and low-voltage flag. Nothing
   is reset. A device whose application is silent but whose bootloader
   answers (an earlier flash was interrupted) is found by a harmless `HELLO`
   probe and planned for **recovery**.
2. **Catalog** — lists the GitHub Releases of the repository configured for
   each device class, filters by channel, and picks the newest release that
   ships an application-only `.bin` and whose `metadata.json` does not demand a
   newer CLI.
3. **Plan** — a pure function (`src/S1TTXX/fwu/policy.ts`) that gives *every*
   device a verdict. A device not updated always carries a stable
   `skipReason` token, never silence.
4. **Apply** — flashes in order, re-checks each pack just before its flash,
   and reads the version back from the running application afterwards.

### Safety

- **Interface boards before powerbanks.** The station decodes powerbank
  responses by strict payload-length equality, so a pack must never run ahead
  of its board. If a board's own update fails, its packs are not attempted
  this run (`BOARD_UPDATE_FAILED`) — a board in its bootloader cannot relay.
- **Powerbank gates:** present, retained by the slot, no low-voltage flag, and
  at least `minBatteryPercent` (default 30%). An unreadable charge skips rather
  than assumes full — except for a recovery flash, which cannot make a stuck
  pack worse since an application flash never writes the bootloader.
- **Re-checked at the last second.** The plan is minutes old by the time a
  pack's turn comes. Immediately before each flash the same gate function runs
  again, plus an identity check: a pack swapped in since planning is skipped
  (`SLOT_CHANGED`).
- **Application images only.** Both firmware families also publish a `merged`
  image for SWD bring-up; streamed through the update path it would brick the
  device. `merged` and `bootloader` assets are refused by a floor that no
  configuration can remove.
- **Verified downloads** — size, and digest when GitHub supplies one; `.part`
  rename so a power cut cannot leave a truncated image; a wall-clock deadline.
- **Verified flashes** — the version is read back from the running
  application; a mismatch is a failure.
- **Interrupted flashes are remembered.** An in-flight marker is written before
  each flash; a run that was killed is counted as a failure by the next one,
  and the stranded device is recovered.
- **Quarantine.** A device that fails the same version `maxFailures` times is
  parked until a different release appears, so one broken unit cannot eat
  every maintenance window.
- **Bounded runs.** At most `maxTargets` devices (default 6) and no new device
  after `maxDurationSeconds` (default 20 min); the device in progress always
  finishes.
- **One flasher at a time.** A lock file is held for every flash, including the
  one-shot `firmware-update` / `pb-firmware-update` commands. Other programs
  that drive the serial port (the kiosk app) read it and stand down instead of
  interrupting a flash. Stale locks — dead owner, reboot, or too old — are
  recovered automatically.

### Options

Every setting has a configuration key; the flags override it for one run.

| Option | Meaning |
|---|---|
| `--config <path>` / `--config-stdin` | Extra configuration from a file, or piped JSON (the way to pass credentials). |
| `--channel stable\|beta` | `beta` additionally accepts GitHub pre-releases. |
| `--targets interface,powerbank` | Restrict to one device class. |
| `--boards 0-2` / `--slots 1,4,7-9` | Restrict to specific hardware. |
| `--min-battery <percent>` | State-of-charge floor for powerbanks. |
| `--max-targets <n>` / `--max-duration <s>` | Bound one run. |
| `--dry-run` | Plan and download, but never flash. |
| `--force` | Re-flash even when already up to date; overrides quarantine. |
| `--allow-downgrade` | Permit flashing an older release over a newer build. |
| `--trace <id>` | Correlation id for this run's log records (default: generated). |
| `--no-hints` | Keep stderr quiet. |

Exit codes: `0` success, `1` failure (or at least one update failed), `10`
from `fw-plan --fail-on-pending` when updates are available but not applied.

## Configuration

One JSON document, assembled from layers — later wins:

| # | Layer | Typical use |
|---|---|---|
| 1 | built-in defaults | generic and conservative; no deployment knowledge |
| 2 | `/etc/station-cli/config.json` | station-wide: where firmware comes from, where state lives |
| 3 | `$XDG_CONFIG_HOME/station-cli/config.json` | per operator |
| 4 | `STATION_CLI_*` environment | CI, containers |
| 5 | `--config <file>` or `$STATION_CLI_CONFIG` | an explicit file |
| 6 | `--config-stdin` | programs calling the CLI — **credentials** |
| 7 | flags (`--channel`, …) | one run; **never credentials** |

```json
{
  "version": 1,
  "firmware": {
    "channel": "stable",
    "sources": {
      "interface": { "provider": "github", "repo": "your-org/S1TTXX-firmware" },
      "powerbank": { "provider": "github", "repo": "your-org/P1TT2C-firmware" }
    },
    "cacheDir": "/var/lib/station-cli/firmware",
    "stateFile": "/var/lib/station-cli/fwu-state.json"
  },
  "logging": { "jsonlFile": "/var/lib/station-cli/station-cli.jsonl" }
}
```

**Credentials.** A credential passed as a flag would be readable by every user
on the machine through the process list, so the CLI refuses one. Pipe it in
with `--config-stdin`, or set `STATION_CLI_GITHUB_TOKEN`. Inside the CLI a
credential is held in a type whose every text form is `<redacted>`, so it
cannot reach the JSON output or a log by accident. A configuration file that
holds a credential and is readable by other users is flagged (`chmod 600`).

```bash
station-cli config check     # effective config, which layer set each key, what is missing
station-cli config schema    # JSON Schema, for editors and callers
```

## Logs

With `logging.jsonlFile` set, every run appends structured records — one JSON
object per line, UTC timestamps, and a `trace` id shared with the command's
JSON output:

```json
{"v":1,"ts":"2026-09-26T12:03:12.481Z","lvl":"warn","cat":"firmware","svc":"fwu_engine","src":"station-cli","trace":"fwu-7f3a2c","msg":"skipped powerbank slot 13: SLOT_CHANGED (…)","ctx":{"slot":13}}
```

Every `fw-*` command ends by printing, on stderr, the exact command to
investigate that run:

```bash
jq -c 'select(.trace=="fwu-7f3a2c")' /var/lib/station-cli/station-cli.jsonl   # one run
jq -c 'select(.lvl=="error")'        /var/lib/station-cli/station-cli.jsonl   # all errors
grep '"lvl":"error"'                 /var/lib/station-cli/station-cli.jsonl   # no jq? still works
```

## Tests

```bash
npm run test:unit
```

No hardware is needed: in-memory fake devices speak the firmware-update
protocol, so the real code runs end to end. CI runs the suite on every build.

| File | Covers |
|---|---|
| `fwu_golden.test.js` | Every frame of a flash, byte for byte, across 13 scenarios per device class — the proof that refactors change nothing on the wire |
| `fwu_engine.test.js` | The engine against a fake station: ordering, re-checks, interrupted flashes, recovery, time budget, quarantine |
| `fwu_policy.test.js` | The pure planner and its gates |
| `config.test.js` | Layer precedence, validation, and that a credential cannot leak |
| `fwu_lock.test.js` | The firmware lock, including stale-lock recovery |
| `fwu_cli.test.js` | The built binary, spawned: refusals and the stdout/stderr contract |
| `fwu_http.test.js`, `fwu_catalog.test.js`, `fwu_wire_validation.test.js`, `check_workflows.test.js` | Downloads, asset rules, host-side guards, the CI guard |

If a golden test fails, the wire protocol changed. Regenerate only when that
change is intended: `UPDATE_GOLDEN=1 npm run test:unit`.

## Documentation

The full documentation lives in the wiki—use it as the source of truth:
- [Home](../station_cli.wiki/Home.md) — overview and quick links
- [Getting Started](../station_cli.wiki/Getting-Started.md) — installation, models, first commands, logging
- [Protocols](../station_cli.wiki/Protocols.md) — S1TTXX binary framing, S0RUXX ASCII framing
- [Commands](../station_cli.wiki/Commands.md) — complete CLI reference
- [Tests](../station_cli.wiki/Tests.md) — integration scripts and harnesses
- [Troubleshooting and Debugging](../station_cli.wiki/Troubleshooting-and-Debugging.md)
- [Development](../station_cli.wiki/Development.md)
- [Release Process](../station_cli.wiki/Release-Process.md)

GitHub wiki URL: https://github.com/Tomorrow-Tech-s-r-l/station_cli/wiki
