# Contributing to station-cli

This repository is **public**, and the binary it builds runs unattended on
stations in the field. Both facts shape the rules below.

## Nothing deployment-specific in the source

The CLI is a generic tool for S1TTXX stations. It must not contain the names
of any organisation's repositories, hosts, paths or credentials. Everything a
deployment needs arrives at run time through the layered configuration
(`src/config/`). If you find yourself typing a repository name into a `.ts`
file, it belongs in a configuration example instead.

## Credentials

- Never add a flag that takes a credential. `argv` is readable by every user
  on the machine. Credentials come from `--config-stdin`, a `0600` file, or
  the environment.
- Hold credentials as `Secret` (`src/config/secret.ts`) and call `reveal()`
  only at the point of use. Every other rendering is `<redacted>` by
  construction; keep it that way.

## Tests, and the golden transcripts

Run `npm run test:unit` before pushing; CI runs it on every build and nothing
is released if it fails.

`tests/golden/fwu/` records every frame the host sends during a flash, for
each scenario. A failing golden test means the bytes on the wire changed. If
that was not your intent, it is a bug. If it was, regenerate with
`UPDATE_GOLDEN=1 npm run test:unit`, and explain in the commit message what
changed on the wire and why the result object is (or is not) unchanged —
the kiosk app parses it.

## The JSON output is an API

Other programs parse what the commands print. Fields may be **added**
freely. Renaming, removing or retyping a field is a breaking change: it needs
a coordinated version bump with the programs that consume it. Hints and
progress go to **stderr**; stdout is only ever the one JSON result.

## Self-hosted runners

Our builds run on self-hosted runners. On a public repository, a workflow a
pull request can trigger runs code chosen by whoever opened it, on a machine
inside our network.

- Never give a workflow that runs on a self-hosted runner a trigger a fork
  controls: `pull_request`, `pull_request_target`, `issue_comment`,
  `workflow_run`, and the like. Use a GitHub-hosted runner for those.
  `scripts/check-workflows.js` enforces this in CI.
- That check catches mistakes in review. It is **not** the boundary against
  forks, because a fork's pull request can bring its own workflow files. The
  boundary is configuration, and maintainers should keep it set:
  - *Settings → Actions → General → Fork pull request workflows*: require
    approval for all outside collaborators.
  - The self-hosted runners' **runner group** must not allow public
    repositories, or must be limited to this repository's release workflow
    on the protected branches.
