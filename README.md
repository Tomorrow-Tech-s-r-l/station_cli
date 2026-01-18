# Station CLI

Cross-platform CLI for managing station boards and powerbanks (S1TTXX and S0RUXX protocols).

## Quick start

Download the latest release binary, connect the station over USB, and run:

```bash
station-cli slots           # default model S1TT30
station-cli S1TT6 slots     # single-board model
```

Add `--log` to any command to save output to a timestamped file. For build-from-source steps or additional models (including S0RUXX), follow the wiki.

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
