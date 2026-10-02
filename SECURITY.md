# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
**Security → Report a vulnerability** on this repository, not in a public
issue. Include the station model, the station-cli version (`station-cli
--version`), and steps to reproduce.

## Scope worth knowing

station-cli talks to station hardware over a local serial link and, for
firmware updates, downloads images from the release repositories its
configuration names.

- **Firmware images** are accepted only as application-only binaries, verified
  against the size and digest the release API reports, and verified again by
  each device's bootloader (CRC32) before its header is stamped.
- **Credentials** are accepted only from stdin, a configuration file or the
  environment — never from command-line flags — and are redacted from all
  output by construction. A world-readable file holding one is flagged.
- **Physical access.** Anyone with access to a station's USB serial port can
  issue the same commands this tool does, including releasing powerbanks.
  Publishing this tool does not change that; securing the cabinet does.
