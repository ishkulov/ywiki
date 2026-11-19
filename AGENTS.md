# AGENTS.md

`ywiki` is a read-only, zero-dependency Node CLI for Yandex Wiki. Install and
usage live in [`README.md`](README.md); this file holds the rules that keep the
tool read-only, dependency-free, and token-safe.

## Hard rules

- **Read-only by semantics.** Every subcommand reads; the only non-GET call is
  `POST /search`. A subcommand that changes Wiki state is out of scope, not a
  feature.
- **One credential, one timer.** Reuse `~/.config/legacy/legacy/credentials.toml` and the
  existing `the legacy refresh helper` timer. Never write the credential file, and never
  create a second credential, timer, or token source.
- **The token stays inside `ywiki`.** Read it in-process only; never via `argv`,
  never in stdout/stderr/logs/commits, never in cache files. `redact()`
  (`lib/credentials.mjs`) is the single choke point; a 6-char prefix is the only
  display allowed.
- **Never call the Wiki API outside `ywiki`** (no `curl`), and never read the
  credential file directly.
- **Zero dependencies, no new runtime.** Node ≥ 20, ESM `.mjs` + JSDoc, tests via
  `node --test`. Do not add an npm dependency, a bundler, or `bun`.
- **Endpoints come from [`docs/wiki-api-notes.md`](docs/wiki-api-notes.md).** Do
  not invent endpoints, parameters, or request bodies; if the note is silent,
  stop and ask.
- **Never commit page content, response dumps, or secrets.**

## Layout

| Path | Role |
|---|---|
| `bin/ywiki.mjs` | argv parsing, subcommand dispatch, exit codes |
| `lib/credentials.mjs` | credential load, auth headers, `redact()` |
| `lib/refresh.mjs` | single-flight `the legacy refresh helper --refresh` + cooldown |
| `lib/client.mjs` | HTTP, retries, 401 self-heal, disk cache |
| `lib/output.mjs` | `EXIT` codes, `WikiError`, clipping, usage text |
| `test/*.test.mjs` | offline tests; fixtures in `test/fixtures/` |

## Tests

`npm test` (i.e. `node --test 'test/*.test.mjs'`) must be green and must run
offline: credentials come from a tmp `LEGACY_CREDENTIALS`, and the real
`the legacy refresh helper` is replaced by a stub via `LEGACY_AUTH`. The real credential file is
never read. Write fixtures and stubs before the first test.

> Node 24's `node --test test/` (directory argument) is broken — keep the quoted
> glob form used in `package.json`.

## Commits and reports

One task per commit: `feat: …` / `fix: …` / `docs: …`. After a task, report
`DONE | artifacts | verification command | result | next`.

## Where the truth lives

- [`README.md`](README.md) — install, usage, flags, env vars, exit codes, auth.
- [`docs/runbook.md`](docs/runbook.md) — operations, troubleshooting, token lifecycle.
- [`docs/wiki-api-notes.md`](docs/wiki-api-notes.md) — the confirmed Wiki API surface.
- [`docs/plan.md`](docs/plan.md) — the original v2 build plan (historical).
