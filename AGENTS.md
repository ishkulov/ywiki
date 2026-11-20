# Working on ywiki

`ywiki` is a zero-dependency Node CLI for Yandex Wiki. Install and usage live in
[`README.md`](README.md); this file holds the rules that keep the tool
dependency-free, token-safe, and reads-by-default. Every change keeps the rules
below true and leaves `npm test` green on Node 20 (CI: 20/22/24).

## Hard rules

- **Reads by default; the write surface is one prefix.** Wiki mutations exist
  only as `page …` verbs and have no shortcuts, so one permission rule on
  `ywiki page` can gate the whole write surface. The read and write verb lists
  are in README's Commands block. `api` is `GET`-only; every write supports
  `--dry-run` and sends nothing with it.

- **Inline comments are two writes.** `inline_text` is metadata; the anchor is
  the `&[text](id)` marker in the page content. To add: create the comment, then
  edit in the marker; if the edit fails, delete the comment. To delete: remove
  the comment, then the marker; if the marker write fails, report `marker_error`
  — the marker is dangling.

- **Writes are never replayed.** A timeout or `5xx` on a mutation leaves the
  outcome unknown: report it and tell the caller to re-read the page. A `401`
  may be retried once after refresh, reads and mutations alike, because a
  rejected request has no side effects.

- **One credential, lazily refreshed.** `ywiki` owns
  `~/.config/ywiki/credentials.toml`; refresh is lazy and single-flight.
  Credential writes go through `writeCredential()` only.

- **The token stays inside `ywiki`.** Read it in-process through
  `lib/credentials.mjs`; it never appears in `argv`, stdout/stderr, logs,
  commits, or cache files. `redact()` is the single choke point for token-bearing
  strings; only a 6-character prefix may be displayed.

- **All Wiki API traffic goes through `ywiki`.** `lib/client.mjs` is the only
  caller of the Wiki API.

- **Use the confirmed Wiki API surface.** Endpoints, parameters, and request
  bodies come from [`docs/wiki-api-notes.md`](docs/wiki-api-notes.md).

- **Zero dependencies, no new runtime.** Node ≥ 20, ESM `.mjs` + JSDoc, tests
  via `node --test`.

- **The version lives only in `package.json`.** `bin/ywiki.mjs` reads it for
  `--version`; do not hardcode a version anywhere else (release = bump
  `package.json` only).

## Stop and ask

Before any of these, stop and raise it with the user:

- a new dependency, bundler, or runtime;
- a second token source, refresh timer, or credential store;
- a mutating verb outside `page …`;
- an endpoint, parameter, or request body outside the confirmed API surface.

## Layout

| Path | Role |
|---|---|
| `bin/ywiki.mjs` | argv, dispatch, exit codes; the only wiring layer |
| `lib/*.mjs` | helpers and I/O modules; each file header names its job |
| `test/*.test.mjs` | offline tests; fixtures in `test/fixtures/` |

Keep helpers pure: no network and no filesystem in `write`, `inline`, `history`,
`diff`, or `comments`. The I/O modules are `auth`, `client`, `credentials`,
`oauth`, `refresh`, and `output`.

## Tests

The suite is offline: credentials from a tmp `WIKI_CREDENTIALS`, `yc` replaced
by a stub via `WIKI_YC_BIN`, and HTTP stubbed with `fetchImpl`. Never touch the
real credential file or the network. A new behaviour lands with a test; its
fixtures and stubs come with it.

> Keep the script as `node --test test/*.test.mjs` (unquoted): Node 20 does not
> expand a quoted glob, and the directory form picks up `test/fixtures/`.

## Commits and reports

One task per commit, Conventional Commits (`feat`, `fix`, `docs`, `chore`,
`ci`, `refactor`). Commits carry code, tests, and docs; page content, response
dumps, and secrets stay out. Close with
`DONE | artifacts | verification command | result | next`, e.g.
`DONE | AGENTS.md | npm test | 193 pass | apply review`. Report the command you
actually ran; if you did not run it, say so.

## Style

Code comments and docs are English; help text is English. Match the language of
the surrounding command's runtime messages.

## Where the truth lives

- [`docs/runbook.md`](docs/runbook.md) — operations, troubleshooting, token lifecycle.
- [`docs/conventions.md`](docs/conventions.md) — command shape, output modes and exit codes.
- [`docs/agent-permissions.md`](docs/agent-permissions.md) — OpenCode permission example.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development setup, pull requests, changelog.
