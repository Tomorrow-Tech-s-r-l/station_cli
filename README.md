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
them. Three commands, each printing a single JSON object to stdout:

```bash
station-cli fw-status                 # what is installed right now (read-only, no network)
station-cli fw-plan                   # + resolve releases and report what would change
station-cli fw-apply                  # + actually flash it, verifying every device
```

A typical unattended invocation, e.g. from the kiosk app or a cron job:

```bash
GITHUB_TOKEN=... station-cli fw-apply --channel stable --min-battery 30 --max-targets 4
```

### How it decides

1. **Inventory** — reads the firmware version of every interface board
   (`CMD_GET_FW_VER`) and of every docked powerbank (`CMD_PB_FW_VER`), plus each
   slot's occupancy, retention, state of charge and low-voltage flag. Nothing is
   reset and no bootloader is entered, so this is safe to run at any time.
2. **Catalog** — lists the GitHub Releases of `S1TTXX-firmware` and
   `P1TT2C-firmware`, filters by channel, and picks the newest release that
   ships an application-only `.bin` and whose `metadata.json` does not demand a
   newer CLI than the one running.
3. **Plan** — compares installed against available and applies the safety gates
   below, producing a verdict for *every* device. A device that is not updated
   always carries a stable `skipReason` token, never silence.
4. **Apply** — flashes in order, then reads the version back from the running
   application to prove the device rebooted into it.

### Safety gates

- **Interface boards are flashed before powerbanks.** The station decodes
  powerbank responses by strict payload-length equality, so a pack must never
  run ahead of the board it is docked in.
- A powerbank is skipped unless it is **present**, **retained** by the slot (not
  mid-eject), free of a **low-voltage** flag, and at or above `--min-battery`
  (default 30%). A pack whose charge cannot be read is skipped, never assumed
  full — a brown-out mid-write is the one failure its bootloader cannot recover
  from unattended.
- Only the **application-only** image is ever accepted. Both firmware repos also
  publish a `merged` image for SWD bring-up; streaming one of those through the
  update path would write bootloader bytes into the application slot and brick
  the device, so `merged` and `bootloader` assets are rejected by name.
- Downloads are verified against the size (and digest, when GitHub supplies one)
  the API reported, and land in the cache via a `.part` rename so a power cut
  cannot leave a truncated image behind.
- A device that fails the **same version** three times in a row is quarantined
  and skipped until a different release appears, so one broken unit cannot eat
  every maintenance window. State lives in `~/.amperry/fwu-state.json`.
- Every flash is followed by a **version read-back**; a mismatch counts as a
  failure and is retried next run.

### Options worth knowing

| Option | Meaning |
|---|---|
| `--channel stable\|beta` | `beta` additionally accepts GitHub pre-releases. |
| `--targets interface,powerbank` | Restrict to one device class. |
| `--boards 0-2` / `--slots 1,4,7-9` | Restrict to specific hardware. |
| `--min-battery <percent>` | State-of-charge floor for powerbanks (default 30). |
| `--max-targets <n>` | Cap devices touched per run; the rest wait for the next one. |
| `--dry-run` | Plan and download, but never flash. |
| `--force` | Re-flash even when already up to date; also overrides a quarantine. |
| `--allow-downgrade` | Permit flashing an older release over a newer build. |
| `--attempts <n>` | Attempts per device before giving up (default 2). |
| `--github-token <token>` | Defaults to `$GITHUB_TOKEN` (the firmware repos are private). |
| `--cache-dir` / `--state-file` | Override the image cache and quarantine state locations. |

Exit codes: `0` success, `1` failure (or at least one update failed), and `10`
from `fw-plan --fail-on-pending` when updates are available but not applied.

### Unit tests

The decision engine is pure and covered by `tests/fwu_policy.test.js`:

```bash
npm run test:unit
```

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
