---
name: cli-kiosk-version-sync
description: Keeps the station_cli ↔ amperry_kiosk_local (and ↔ firmware) contract honest whenever the JSON the CLI emits, the commands the kiosk invokes, or the firmware wire parsing is touched. Floors are computed by CI from contract runs, never hand-declared; this skill makes sure a contract change is covered by a contract CHECK so the computed floors move with it.
when_to_use: Any change to station_cli that could alter the bytes the kiosk reads from CLI output or the commands the kiosk can issue. In particular - edits to src/S1TTXX/protocol/types.ts (PowerbankInfo, PowerBankServer, SlotsInfo, SlotsResponse, SlotState, SlotError shapes); edits to src/S1TTXX/cli/commands/status.ts or slots.ts response parsing; edits to src/S1TTXX/cli/cli.ts that change the JSON written to stdout (the kiosk parses this with JSON.parse); new/renamed/removed CLI subcommands the kiosk shells out to; changes to firmware wire-format parsing offsets in commands that the kiosk consumes. Skip for pure refactors, comment changes, internal helpers, or test-only edits that don't change stdout JSON.
---

# station_cli ↔ kiosk ↔ firmware contract

The kiosk shells out to the `station-cli` binary and parses its stdout JSON;
the CLI speaks the station firmware's wire protocol. Which versions work
together is **computed**, not declared:

| What | Where it comes from |
|---|---|
| CLI version / release tag | `package.json` → `version` (CI tags `vX.Y.Z` on main, `dev-vX.Y.Z` on development) |
| Every floor between kiosk, station_cli, S1TTXX, P1TT2C | `compatibility.json`, published by release-compat (release `current`), computed from `compat-evidence/v1` of the contract suites |
| This release's `metadata.json` (`requires`, legacy `cli_version` / `min_kiosk_app_version`, `capabilities`) | the release job in `build.yml`, from this run's evidence via `compat floor` / `compat metadata` — a legacy field the evidence does not cover is carried forward (from the published compatibility.json's newest earlier release with an evidence-backed floor, else from a computed earlier metadata.json) and listed in `computed.carried_forward`; it never rises above the newest earlier release's published value without a tested kiosk failure at or above it (`computed.legacy_clamped` / `legacy_raised`) |
| What a binary supports | `station-cli capabilities --json` (generated from the command tree) |

There is no `minKioskAppVersion` in package.json, no `minCliVersion` constant
in the kiosk, and nothing to scrape. Do not add one back.

## The contract suites (what makes a floor move)

| Suite | Runs | Pair |
|---|---|---|
| `firmware_contract.yml` (here) and S1TTXX `cli_contract.yml` | this CLI against station_sim built from the firmware's own protocol code, packs from a P1TT2C tree | S1TTXX × station_cli (P1TT2C as context) |
| P1TT2C `pogo_contract.yml` | the real pack code against the board's pogo code, byte level | S1TTXX × P1TT2C |
| kiosk `kiosk_cli_contract.yml` | the real kiosk SlotCommandsService against the real CLI binary on station_sim | kiosk × station_cli |

A check's `tier` decides whether it gates: `core` checks move floors (a
skipped core check is a failure), `feature` / `diag` are reported only.

## Procedure when the contract changes

1. **Restate the change in one sentence**: "I added `packVoltageMv` to the
   status JSON."
2. **Make sure a contract check covers it.** A renamed or removed field the
   kiosk reads must fail a `core` check in kiosk_cli_contract (kiosk repo) or
   cli_contract (S1TTXX harness) — that failure is what raises the floor. If
   no check would notice, say which check to add and in which repository.
3. **New command or flag the kiosk will call:** it appears in
   `capabilities --json` automatically; the kiosk should probe for it there,
   not compare versions.
4. **Bump `package.json` `version`** as usual (minor for additive, major for a
   breaking change) — the version is a name, not a compatibility claim.
5. You cannot edit the kiosk or firmware repos from here: list the checks to
   add there as a checklist (file, what to assert).

## Don't

- Don't write a version floor anywhere (package.json, constants, docs, a
  harness `minCli:` gate). Gate on capabilities; let the evidence set floors.
- Don't hand-edit `metadata.json` — it is generated in CI and not committed.
- Don't classify releases by GitHub's prerelease flag or order them by date:
  the tag grammar and SemVer precedence (`0.5.0-dev < 0.5.0`) decide.
