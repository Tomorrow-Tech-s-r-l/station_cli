# Tests

This folder contains simple shell scripts that exercise the `station-cli` executable under `../executables`.

## Prerequisites

- Ensure one of these executables exists and is runnable:
  - `../executables/station-cli-macos`
  - `../executables/station-cli-macos-arm64`
- Optional: install `jq` for cleaner JSON parsing in outputs.

## Scripts

### `interrogate_status.sh`

Interrogate a single slot multiple times and summarize success vs timeout failures.

Usage:
```bash
./interrogate_status.sh
```

You will be prompted for:
- Slot index (1-30)
- Number of times to interrogate
- Delay in milliseconds between attempts (default: 5)

### `interrogate_slots_all.sh`

Interrogate the `slots` command multiple times and summarize successes, errors, and timeout failures.

Usage:
```bash
./interrogate_slots_all.sh
```

You will be prompted for:
- Platform (macOS, Linux, Windows)
- Model (S1TT30 or S1TT6)
- Number of times to call `slots`
- Delay in milliseconds between attempts (default: 5)

### `interrogate_status_all.sh`

Interrogate all slots (1-30) multiple times and summarize per-slot and overall results.

Usage:
```bash
./interrogate_status_all.sh
```

You will be prompted for:
- Number of times to interrogate each slot
- Delay in milliseconds between attempts (default: 5)

### `test_convert.sh`

Run a suite of `convert` command tests (valid frames plus invalid input checks).

Usage:
```bash
./test_convert.sh
```

### `unlock_all.sh`

Unlock a range of slots multiple times and summarize per-slot and overall results.

Usage:
```bash
./unlock_all.sh
```

You will be prompted for:
- Starting slot index (1-30)
- Ending slot index (1-30)
- Number of times to unlock each slot
- Delay in milliseconds between attempts (default: 5)
