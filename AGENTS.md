# AGENTS.md

`ywiki` is a zero-dependency Node CLI for Yandex Wiki. Install and usage live in
[`README.md`](README.md); this file holds the rules that keep the tool
dependency-free, token-safe, and reads-by-default.

## Hard rules

- **Reads by default; writes are explicit.** Reads live under `page get|search|
  descendants|locate|history|revision|diff|comments`, `page comment list|thread`,
  `space list`, and the flat shortcuts. Mutations exist only as
  `page create|edit|append|delete` and `page comment add|reply|delete`, and have
  **no** shortcuts: the write surface must stay identifiable by one prefix so a
  permission rule can gate it.
  `ywiki api` stays `GET`-only. Do not add a mutating subcommand outside those
  verbs.
- **Inline comments are two writes.** `inline_text` is metadata; the anchor is
  the `&[text](id)` marker in the page content. Create the comment, then edit the
  page with the marker; on a failed page edit, delete the comment. Deleting an
  inline comment removes its marker in a second write.
- **Writes are never replayed.** A timeout or `5xx` on a mutation means the
  outcome is unknown: do not auto-retry; tell the caller to re-read the page.
  A rejected request (`401`) may be retried after refresh, since it has no side
  effects. Only idempotent reads are cached; a successful write clears the cache.
- **One Wiki credential, no timer.** `ywiki` owns
  `~/.config/ywiki/credentials.toml` (schema v2). Refresh is lazy and single-flight:
  IAM via `yc iam create-token`, OAuth via the stored `refresh_token`. Do not add
  a timer or a second token source. Writes to the credential file go through
  `writeCredential()` only.
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
| `lib/credentials.mjs` | credential load/store, auth headers, `redact()` |
| `lib/auth.mjs` | `auth login|logout|status`, `yc` runner, token validation |
| `lib/oauth.mjs` | PKCE, authorize URL, loopback callback, token exchange/refresh |
| `lib/refresh.mjs` | lazy 401 refresh: `yc`/OAuth, single-flight + cooldown |
| `lib/client.mjs` | HTTP, retries, 401 self-heal, disk cache |
| `lib/write.mjs` | pure helpers for `page create|edit|append|delete` |
| `lib/inline.mjs` | ranges, `&[text](id)` markers, `page locate` |
| `lib/history.mjs` | revision queries, summaries, current-revision marker |
| `lib/diff.mjs` | pure line diff (LCS + bounded fallback), unified patch |
| `lib/comments.mjs` | comment bodies, queries, summaries |
| `lib/output.mjs` | `EXIT` codes, `WikiError`, clipping, usage text |
| `test/*.test.mjs` | offline tests; fixtures in `test/fixtures/` |

## Tests

`npm test` (i.e. `node --test 'test/*.test.mjs'`) must be green and must run
offline: credentials come from a tmp `WIKI_CREDENTIALS`, the real `yc` is
replaced by a stub via `WIKI_YC_BIN`, and HTTP is stubbed with `fetchImpl`. The
real credential file is never read and no network call is made. Write fixtures
and stubs before the first test.

> Node 24's `node --test test/` (directory argument) is broken — keep the quoted
> glob form used in `package.json`.

## Commits and reports

One task per commit: `feat: …` / `fix: …` / `docs: …`. After a task, report
`DONE | artifacts | verification command | result | next`.

## Where the truth lives

- [`README.md`](README.md) — install, usage, flags, env vars, exit codes, auth.
- [`docs/runbook.md`](docs/runbook.md) — operations, troubleshooting, token lifecycle.
- [`docs/wiki-api-notes.md`](docs/wiki-api-notes.md) — the confirmed Wiki API surface.
- [`docs/conventions.md`](docs/conventions.md) — command shape, output modes and exit codes.
