# Contributing

Thanks for taking a look at `ywiki`. It is a small, deliberately
dependency-free CLI; the rules below are what keep it that way. They match
[`AGENTS.md`](AGENTS.md), which is the authoritative version.

## Ground rules

- **Reads by default; writes are explicit.** Reads live under `page get|search|
  descendants|locate|history|revision|diff`, `page comment list|thread`,
  `space list`, and the flat shortcuts. Mutations exist only as
  `page create|edit|append|delete` and `page comment add|reply|delete`, with
  **no** shortcuts, so a single permission rule on one prefix gates the whole
  write surface. `ywiki api` stays `GET`-only.
- **Writes are never replayed.** A timeout or `5xx` on a mutation means the
  outcome is unknown: do not auto-retry; tell the caller to re-read the page.
- **The token stays inside `ywiki`.** Read it in-process only; never via `argv`,
  never in stdout/stderr/logs/commits, never in cache files. `redact()`
  (`lib/credentials.mjs`) is the single choke point.
- **Never call the Wiki API outside `ywiki`** (no `curl`), and never read the
  credential file directly.
- **Zero dependencies, no new runtime.** Node ≥ 20, ESM `.mjs` + JSDoc, tests
  via `node --test`. Do not add an npm dependency, a bundler, or `bun`.
- **Endpoints come from [`docs/wiki-api-notes.md`](docs/wiki-api-notes.md).** Do
  not invent endpoints, parameters, or request bodies; if the note is silent,
  stop and ask.
- **Never commit page content, response dumps, or secrets.**

## Development

```bash
npm test        # node --test test/*.test.mjs; offline, no network
```

`npm test` must be green and must run offline: credentials come from a tmp
`WIKI_CREDENTIALS`, the real `yc` is replaced by a stub via `WIKI_YC_BIN`, and
HTTP is stubbed with `fetchImpl`. The real credential file is never read and no
network call is made. Write fixtures and stubs before the first test.

> Pass the test files as an **unquoted** shell glob (`node --test
> test/*.test.mjs`): Node 20 does not expand a quoted glob inside `--test`, and
> the bare/directory forms pick up `test/fixtures/` and fail.

## Commits

One task per commit, conventional prefix: `feat: …` / `fix: …` / `docs: …`.
Keep changes consistent with the surrounding structure, naming, and style.

## Pull requests

- Describe the problem and the change; note the verification command you ran
  and its result.
- Keep the write surface identifiable by the `ywiki page` prefix — do not add a
  mutating subcommand outside the documented verbs.
- Update [`README.md`](README.md) and/or [`docs/`](docs) when flags, env vars,
  exit codes, or auth behavior change, and add a [`CHANGELOG.md`](CHANGELOG.md)
  entry under `Unreleased`.
