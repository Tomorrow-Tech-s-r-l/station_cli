# Station CLI

Cross-platform CLI for managing station boards and powerbanks (S1TTXX and S0TTXX protocols).

## Quick start

Download the latest release binary, connect the station over USB, and run:

```bash
station-cli slots           # default model S1TT30
station-cli S1TT6 slots     # single-board model
station-cli slots -m S1TT6  # same, as a flag (--model also works)
station-cli ports           # list serial ports and the one auto-detect picks
station-cli slots -p COM3   # use a specific port (or set STATION_CLI_PORT)
```

The model is `S1TT30` (default), `S1TT6`, `S0TT6`, `S0TT12` or `S0TT18`; `station-cli --help` lists them and `station-cli <command> --help` shows the ranges for the selected one. On Windows run `station-cli-windows-x64.exe ports` to find the station's COM port, then pass it with `-p`.

Add `--log` to any command to save output to a timestamped file. For build-from-source steps or additional models (including S0TTXX), the serial port options and Windows usage, follow the wiki.

## Testing and debugging

Not for production — the kiosk app never uses these. `station-cli --help` lists
commands in three groups: *Production commands* (what the kiosk app runs, plus
`ports` and `config`), *Testing commands* and *Experimental commands (S0TTXX)*;
the testing modes are under *Testing options*.
Traces go to stderr; stdout stays the one JSON result.

```bash
station-cli status -i 3 --raw            # every TX/RX frame, hex + timing + status
station-cli slots --no-retry --raw       # ask each powerbank once, no CLI retries
station-cli pb-link-stats -b 0 --reset   # station-side link attempts/retries/timeouts
```

- `--raw` prints, per exchange, the request (command, board, slot), the bytes
  sent (payload and full frame with SOF/CRC), the raw frame received with its
  latency, and the decoded reply (status and data bytes).
- With a **trace build of the station firmware** (S1TTXX-firmware built with
  `CONFIG_AMPERRY_TRACE_WIRE`, the CI `trace-binaries` artifact), `--raw` also
  prints `STATION` lines after every powerbank request: what the station itself
  sent and received on the pogo link, for every exchange of the request (STATUS
  on an older pack is two: `PB_CMD_INFO_EXT`, rejected, then `PB_CMD_INFO`) and
  every attempt, and why an attempt failed
  (nothing received, line noise, or bytes rejected). One station reply carries
  at most 50 bytes, so the CLI reads this log in 40-byte pages and joins them;
  each trace says how many bytes and pages were read and flags a log that could
  not be read completely. The station keeps at most 192 bytes per request (its
  RAM is nearly full): the request is shown once, and reply bytes or attempts
  that did not fit are marked as such. Release
  firmware prints a one-line "trace not available" notice instead.
- `--no-retry` turns off the CLI's retries (the 150/400 ms re-sends after a
  powerbank timeout and the second status read in `slots`) and, when the
  station firmware has host opcode 0x54 (probed, not assumed from a version),
  the station's own pogo-link retries too: it lowers
  them to 1 attempt on each board the command talks to and restores them when
  the command ends (the station also restores them on every boot). On older
  firmware only the CLI retries are off, and a `[TEST]` line says so.
- `pb-link-attempts -b <n> [--set 1|2|3] [--reset]` reads or sets the station's
  retries by hand (testing command; a station firmware without host opcode
  0x54 answers that it does not support it).
- Testing commands: `pb-firmware`, `pb-link-stats`, `pb-link-attempts`, `convert`.
- Experimental: the S0TTXX commands (`s0ttxx-query`, `s0ttxx-unlock`) and the
  `S0TT6`/`S0TT12`/`S0TT18` models.

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
   each device class, classifies them by tag (`vX.Y.Z` production,
   `dev-vX.Y.Z` development; `stable` takes production only), and walks them
   newest first in SemVer order (`dev-v3.2.0` < `v3.2.0`). It offers the first
   that ships an application-only `.bin` and that **compatibility.json**
   accepts: the release was tested, its floors are met by this CLI and by the
   firmware installed on the station, and the installed releases' own floors
   accept it back. The floors are those of the station's channel: `stable`
   reads the production floors, `beta` the development ones (see
   [Compatibility](#compatibility)). A device that reports a bare `X.Y.Z` may run `vX.Y.Z` or
   `dev-vX.Y.Z`, and both must pass. A powerbank image is offered only when
   the boards it sits in are compatible with it — as they run now and as the
   board release of the same run would leave them; a board image only when
   every pack docked in the boards is (a run limited to interfaces or to some
   slots still reads them). No compatibility data — not published, not
   cached, not bundled — means nothing is offered (fail closed); the JSON's
   `compatibility` field says which copy was used, and `warnings` why each
   newer release was skipped. A firmware release published before the
   cutover (legacy) is never refused for lack of testing: a pair nobody
   tested keeps the rule it shipped with (its `metadata.json`
   `min_cli_version`), and only a tested failure blocks it. See
   [Compatibility](#compatibility).
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

**A local release folder** (`"provider": "dir"`) takes the place of a GitHub
repository, for testing a firmware build before it is published — on a bench
station or the station emulator (its firmware OTA e2e serves releases this
way). It is laid out like a set of Releases, one folder per tag, and goes
through the same path as GitHub — the channel filter, the merged/bootloader
refusal, the cache and read-back verification — except compatibility: such a
build was never published, so it cannot be in compatibility.json, and the
folder's own `metadata.json` `min_cli_version` is the only floor applied.

```json
"sources": {
  "interface": { "provider": "dir", "path": "/home/pi/fw-test/interface" },
  "powerbank": { "provider": "dir", "path": "/home/pi/fw-test/powerbank" }
}
```
```
/home/pi/fw-test/powerbank/v3.2.0/P1TT2C-firmware-3.2.0.bin      stable
/home/pi/fw-test/powerbank/dev-v3.3.0/P1TT2C-firmware-3.3.0.bin  beta only (dev- tag, or a PRERELEASE file)
/home/pi/fw-test/powerbank/P1TT2C-firmware-3.1.0.bin             flat: tag v3.1.0 from the name
```

The kiosk only fills in `sources` the station config leaves out, so a `dir`
source in `/etc/station-cli/config.json` makes the kiosk's own scheduled
update install that build.

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

## Compatibility

Which firmware, station-cli and kiosk versions work together is not written
anywhere by hand. Contract suites run the real code of each pair against real
releases (`firmware_contract.yml` here, `cli_contract.yml` / `pogo_contract.yml`
in the firmware repositories, `kiosk_cli_contract.yml` in the kiosk), and
release-compat turns their evidence into `compatibility.json` — the floors of
every release towards every other component — published as asset
`compatibility.json` of its release `current`.

The CLI reads it with the GitHub credential, keeps the last good copy next to
the firmware images (`<firmware.cacheDir>/compatibility.json`), and falls back
to the copy bundled into the executable at build time. Floors only gate
installs: nothing already running is stopped because of them.

**Floors per channel.** Each floor (`requires[Y]`) also comes per channel of
the station that installs: `channels.production` is computed over the
production releases of Y only — a production station never installs anything
else, so a failing development pack does not hold its board back —
and `channels.development` over both channels (the same as the top level).
The CLI reads the floors of its update channel (`--channel` / the
`firmware.channel` config): `stable` = `production`, `beta` = `development`;
a file without `channels` uses the top level. The JSON's
`compatibility.channel` says which were read. The rule is release-compat's,
pinned by its shared parity cases
(`tests/fixtures/compat/consumer-parity.json`, a verbatim copy).

**Legacy and enforced releases (the cutover).** Nothing already released
breaks because it was never tested. Each component in the file has an
`enforced_from`, computed by release-compat (never typed): the oldest release
published with computed metadata (schema 2, with `computed.run_url`) — `null`
while there is none, so today every release is **legacy**. For a legacy
firmware release:

- a pair with no evidence — the release was never tested with that component,
  or the installed release is legacy and never tested with it — gets no
  computed constraint. The catalog applies the release's own legacy rule
  instead: towards this CLI, the release's `metadata.json` `min_cli_version`
  (absent: no floor), exactly as before compatibility.json; towards the board
  or the packs, none, as before. The JSON's candidate `compat` lists these in
  `untestedLegacy` and `warnings` says `untested-legacy: …`;
- a pair with evidence follows the full rule, so a **tested failure still
  blocks** it (CLI v0.2.4 is never offered board v3.0.3);
- a legacy release the file does not list at all is left to its legacy rule
  for every pair.

A release at or after the cutover is **enforced**: it must be in the file
with a floor for every edge of its component (installed or not), and the
full rule applies, failing closed. A file without `enforced_from` (written
before cutovers) is read the strict way, every release enforced.

```json
"compat": { "repo": "Tomorrow-Tech-s-r-l/release-compat", "tag": "current", "asset": "compatibility.json" }
```

(the default; `STATION_CLI_COMPAT_REPO` / `_TAG` / `_ASSET` override it).

**Capabilities.** Callers probe what a binary can do instead of comparing
version numbers:

```bash
station-cli capabilities --json   # version, release tag, every command and flag,
                                  # FWU protocol and wire-log versions spoken
```

The release job publishes the same document in `metadata.json`
(`capabilities`), next to the computed floors (`requires`, schema 2) and the
legacy `cli_version` / `min_kiosk_app_version` that kiosks in the field read.
A legacy reader knows no channels, and a release is only installed by
stations of its own channel, so `min_kiosk_app_version` is the floor of the
release's channel (a `vX.Y.Z` release: the production kiosk floor). With no
kiosk evidence of that channel it is carried only from something computed
(its origin goes in `computed.carried_from`): first the published
compatibility.json — the floor of that channel of the newest earlier release
in it that has one backed by evidence (`{source: "compatibility.json",
sequence, tag, evidence}`); else an earlier release whose metadata.json
computed it (schema 2 with `computed.run_url`). With nothing computed to
carry, the release fails. Kiosks in the field must never break: the value
never ends up higher than what the newest earlier release published (any
schema, same channel first — every release so far says `1.2.0`) unless a
kiosk tested at or above that value **failed**. Without that proof the
published value is kept (`computed.legacy_clamped`, a notice); with it the
raise goes through, listed in `computed.legacy_raised` with the failures, as
a warning and a line in the release job's summary. The kiosk's nightly `kiosk_cli_contract` targets the
newest CLI tags of both channels, so the next compatibility.json has evidence
for the new tag.

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
| `unit/compat.test.js`, `unit/compat_catalog.test.js` (`npm test`) | SemVer precedence and the tag grammar on the real release lists, compatibility.json validation, the consumer rule, firmware candidate selection, network/cache/bundled fallback |
| `unit/compat_parity.test.js` (`npm test`) | release-compat's shared consumer-rule cases (per installing channel), and the catalog on the compatibility.json computed from real contract runs |
| `unit/contract_scripts.test.js` (`npm test`) | The CI helpers: contract matrix, evidence verdicts, the release gate, metadata.json floors per channel and carry-forward provenance |

If a golden test fails, the wire protocol changed. Regenerate only when that
change is intended: `UPDATE_GOLDEN=1 npm run test:unit`.

### Firmware contract (CLI ↔ station firmware)

`.github/workflows/firmware_contract.yml` runs this CLI against the S1TTXX
station firmware's own protocol code (a simulated station built from
`host_protocol.c` / `protocol_utils.c` / `pb_protocol.c`, harness in
S1TTXX-firmware `tests/cli_contract`), with powerbanks built from a P1TT2C
tree docked in it. It checks every command the kiosk app
uses (`slots`, `status`, `charge`, `initialize-powerbank` with read-back,
`unlock`, `firmware`, `stats`), plus `pb-firmware`, `pb-link-stats` and the
testing modes (`--raw`, `--no-retry`, `pb-link-attempts`), down to the values
in the JSON. The legs are S1TTXX × P1TT2C: the releases release-compat's
`compat targets` names, plus the `development` / `main` branches. Every leg
becomes a `compat-evidence/v1` result (artifact `compat-evidence`; in a
release run `compat-evidence-unpublished` until the release job has published
the tag, then re-uploaded as `compat-evidence`); for a release of this CLI the
release job sends it to release-compat, which recomputes the floors. Only
runs on `main` / `development` (the release, the nightly, a dispatch on those
refs) publish or report evidence: elsewhere it is `compat-evidence-branch`,
which release-compat never reads. A pairing
of two releases tested next to a branch build is left out of the evidence.
The run (and so the release) goes red when a leg dies, or when this CLI fails
a core check against the newest production S1TTXX and P1TT2C releases tested;
any other failing pair is a fact for the floors. Without `COMPAT_TOKEN` and
`vars.COMPAT_REF` it runs the legacy legs (`development`, `main`, newest
release and dev release) with the P1TT2C `development` branch docked, and
reports no evidence.

| When | CLI under test |
|---|---|
| push to a feature branch | this branch, built from source |
| push to `main` / `development` (`build.yml`) | the linux-x64 executable just built; the release waits for it, and its notes end with the table |
| nightly 03:37 UTC, or *Run workflow* | the branch it runs on |
| after an S1TTXX-firmware release | `main` and `development`, against that release |

S1TTXX-firmware runs the same harness the other way round on every push:
its firmware against this CLI's newest release and dev release executables
and `main` / `development`. After a CLI release, `build.yml` asks it to
re-run against the new executable. Both requests need `RELEASE_TOKEN` to
have `actions: write` on the other repository; without it, the nightly runs
cover the pair within a day. Locally, from an S1TTXX-firmware checkout:

```bash
tests/cli_contract/run.sh ../station_cli                # this checkout, built
tests/cli_contract/run.sh ./station-cli-linux-x64       # a release executable
```

## Documentation

The full documentation lives in the wiki—use it as the source of truth:
- [Home](../station_cli.wiki/Home.md) — overview and quick links
- [Getting Started](../station_cli.wiki/Getting-Started.md) — installation, models, first commands, logging
- [Protocols](../station_cli.wiki/Protocols.md) — S1TTXX binary framing, S0TTXX ASCII framing
- [Commands](../station_cli.wiki/Commands.md) — complete CLI reference
- [Tests](../station_cli.wiki/Tests.md) — integration scripts and harnesses
- [Troubleshooting and Debugging](../station_cli.wiki/Troubleshooting-and-Debugging.md)
- [Development](../station_cli.wiki/Development.md)
- [Release Process](../station_cli.wiki/Release-Process.md)

GitHub wiki URL: https://github.com/Tomorrow-Tech-s-r-l/station_cli/wiki
