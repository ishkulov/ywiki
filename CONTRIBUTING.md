# Contributing

Thanks for taking a look at `ywiki`. It is a small, deliberately
dependency-free CLI. The rules that keep it that way live in
[`AGENTS.md`](AGENTS.md), which is authoritative; read that first. This file
covers the human workflow around it.

## Development

```bash
npm test        # offline; no network
```

The suite is offline: credentials come from a tmp `WIKI_CREDENTIALS`, the real
`yc` is replaced by a stub via `WIKI_YC_BIN`, and HTTP is stubbed with
`fetchImpl`. The exact constraints and the test-glob caveat are in
[`AGENTS.md`](AGENTS.md#tests).

## Commits

Follow the commit and report rules in
[`AGENTS.md`](AGENTS.md#commits-and-reports); one task per commit.

## Pull requests

- Describe the problem and the change; note the verification command you ran
  and its result.
- Keep changes consistent with the surrounding structure, naming, and style.
- Update [`README.md`](README.md) and/or [`docs/`](docs) when flags, env vars,
  exit codes, or auth behavior change, and add a [`CHANGELOG.md`](CHANGELOG.md)
  entry under `Unreleased`.
