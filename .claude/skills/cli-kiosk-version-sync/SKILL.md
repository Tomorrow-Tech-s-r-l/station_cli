---
name: cli-kiosk-version-sync
description: Enforces version coordination between station_cli and amperry_kiosk_local whenever the cross-repo contract (the JSON shape the CLI emits and the kiosk parses, or the slot-command surface the kiosk invokes) is touched. Apply before claiming a CLI change is done — a structural change here that ships without bumping minCliVersion on the kiosk silently breaks installations.
when_to_use: Any change to station_cli that could alter the bytes the kiosk reads from CLI output or the commands the kiosk can issue. In particular - edits to src/S1TTXX/protocol/types.ts (PowerbankInfo, PowerBankServer, SlotsInfo, SlotsResponse, SlotState, SlotError shapes); edits to src/S1TTXX/cli/commands/status.ts or slots.ts response parsing; edits to src/S1TTXX/cli/cli.ts that change the JSON written to stdout (the kiosk parses this with JSON.parse); new/renamed/removed CLI subcommands the kiosk shells out to; changes to firmware wire-format parsing offsets in commands that the kiosk consumes. Skip for pure refactors, comment changes, internal helpers, or test-only edits that don't change stdout JSON.
---

# station_cli ↔ amperry_kiosk_local version contract

The kiosk shells out to the `station-cli` binary and parses its stdout JSON. There is no typed RPC layer in between, just an unwritten contract: "the CLI emits these fields, the kiosk reads these fields." When that contract changes — even additively — both sides must agree on the minimum compatible version of the other.

This skill exists because the contract has already been broken once silently: a structural change shipped without a version bump, and a freshly-deployed kiosk pulling the old CLI binary off GitHub releases would miss the feature with no warning. Don't repeat that.

## The four version fields

These four fields together encode the contract. If you change the CLI's output shape, **at least one row must change**, and usually a coordinated pair.

| Field | File | What it means |
|---|---|---|
| CLI version | `cli/station_cli/package.json` → `version` | The CLI release. Kiosks check this at boot against their `minCliVersion`. |
| CLI's required kiosk floor | `cli/station_cli/package.json` → `minKioskAppVersion` | The oldest kiosk this CLI will tolerate. Bump when the CLI starts emitting fields older kiosks can't parse, or removes fields they relied on. |
| Kiosk version | `app/amperry_kiosk_local/pubspec.yaml` → `version` | The kiosk release (semver + build number, e.g. `1.2.0+51`). |
| Kiosk's required CLI floor | `app/amperry_kiosk_local/lib/constants.dart` → `minCliVersion` | The oldest CLI this kiosk will tolerate. Bump when the kiosk starts reading fields older CLIs don't emit. Checked at boot by `station_cli_version_check_service.dart`. |

## When you change the CLI side

After editing the CLI, classify the change and pick the bump:

| Change shape | CLI `version` | CLI `minKioskAppVersion` | Tell user to bump kiosk |
|---|---|---|---|
| Added a new field to the slots/status JSON, old kiosks ignore it | **minor** | unchanged | optional — kiosk only needs a bump when it starts consuming the new field |
| Renamed or removed a field a kiosk consumes today | **major** | bump to next kiosk release that uses the new name | **yes** — kiosk must bump simultaneously |
| Wire-format byte offsets changed (e.g. new field at the end of CMD_STATUS payload), shape unchanged | **minor** | unchanged (graceful: missing bytes default to 0) | only if kiosk renders the new field |
| New CLI subcommand the kiosk calls | **minor** | unchanged | bump kiosk + its `minCliVersion` |
| Removed CLI subcommand the kiosk calls | **major** | bump to next kiosk release | **yes** |
| Pure refactor, no stdout change | — | — | — |

## Procedure when the contract changes

Before ending the turn, do this:

1. **Restate the change in one sentence**: "I added `packVoltageMv` to `PowerBankServer` and surfaced it in the slots JSON output."
2. **Use `AskUserQuestion`** to confirm the version plan. The first option should be your recommended pair, e.g.:
   - Bump CLI to `0.2.0`, kiosk to `1.2.0+51`, kiosk's `minCliVersion` to `0.2.0`, CLI's `minKioskAppVersion` to `1.2.0` (Recommended)
   - Bump CLI only (additive, kiosk update later)
   - Skip the bump (refactor / no contract change)
3. **Edit `cli/station_cli/package.json`** with the agreed CLI version (and `minKioskAppVersion` if needed).
4. **You cannot edit the kiosk repo from here**, so explicitly tell the user which lines in the kiosk to change and which values to write — file path, current value, new value. Format as a checklist they can act on.
5. **Do not say "done" until step 2 has run.** Skipping the confirmation is the failure mode this skill exists to prevent.

## What to grep for to detect contract changes

Run before assuming a change is internal:

```
src/S1TTXX/protocol/types.ts          # any export change here is a contract change
src/S1TTXX/cli/commands/status.ts     # offset/parse changes
src/S1TTXX/cli/commands/slots.ts
src/S1TTXX/cli/cli.ts                 # `slots.push({...})` block — JSON the kiosk parses
src/S1TTXX/protocol/commands.ts       # wire-format / command opcodes
src/utils/constants.ts                # PB_STATUS_* / SLOT_* — kiosk doesn't import directly, but JSON values come from here
```

If your diff touches any of these, the contract has likely moved.

## Don't

- Don't decide the bump silently. Always ask before editing `package.json`.
- Don't bump `minKioskAppVersion` past the latest released kiosk without flagging it — that bricks every deployed kiosk on update.
- Don't claim "additive change, no kiosk bump needed" without saying *which* field is additive and *why* the kiosk doesn't need it yet. The kiosk may already be planning to use it in a sibling PR.
