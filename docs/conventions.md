# ywiki conventions

`ywiki` is a small CLI with a consistent shape: grouped commands with flat
shortcuts, a single output mode switch, a typed error envelope, and a fixed set
of exit codes. This file records those conventions.

## Command shape

| Aspect | Behaviour |
|---|---|
| Commands | grouped (`page view`, `space list`) with flat shortcuts (`get`, `search`, `tree`, `spaces`) |
| Default output | JSON when piped, ANSI on a TTY |
| Switch | `--json` forces JSON; `--rich-ui=yes\|no` overrides both ways |
| Help | `$ cmd` example line + annotation, `Usage`/`Commands`/`Options` |
| Errors | `Error: <Title>` / detail / `Next:` |
| Credential | `~/.config/ywiki/credentials.toml` (v2), `scheme=iam` or `oauth` |
| Env token | `WIKI_IAM_TOKEN` / `WIKI_TOKEN` + `WIKI_ORGANIZATION_ID` |
| Refresh | lazy 401 self-heal: `yc iam create-token` or OAuth `refresh_token`; no timer |
| Passthrough | `api GET <path>` (read-only subset only) |
| Writes | `page create/edit/append/delete`, `page comment add/reply/delete`; `--dry-run` on all |
| Agent guidance | `skill` |
| Short flags | `-h`/`--help`, `-v`/`--version [--json]` (`-v` prints one line; JSON on `--json`) |
| Flags | `--dry-run`, `--no-input` |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 2 | usage |
| 3 | unauthenticated |
| 4 | access_denied / policy denial |
| 5 | not_found |
| 6 | conflict |
| 8 | unavailable (network, 429/5xx, timeout) |

HTTP → code: `401 → 3`, `403 → 4`, `404 → 5`, `409`/`ALREADY_INDEXING → 6`,
`429`/`5xx`/network/timeout → `8`.

## Design rules

- **Writes are explicit and gated.** Mutations exist only as `page create|edit|
  append|delete` and `page comment add|reply|delete`, with no shortcuts, so a
  permission rule on the single prefix covers the whole write surface. `api`
  accepts only `GET` and only the confirmed Wiki surface (`pages`, `spaces`,
  `users/me`, `search`).
- **Writes are never replayed.** A timeout or `5xx` on a write is reported as
  `unavailable` without a retry; the caller must re-read the page.
- **Own credential and refresh.** `ywiki` stores its own
  `~/.config/ywiki/credentials.toml` and refreshes lazily on `401`
  (`yc iam create-token` for IAM, `refresh_token` for OAuth).
- **ENV names are `WIKI_*` only.**
- **`auth login` methods.** `browser` (OAuth + PKCE, the TTY default when a
  client id is configured), `token` (paste OAuth/IAM), and `iam`
  (`yc iam create-token`, the TTY default otherwise) are available. In a TTY the
  method and, when absent, the organization id are prompted; outside a TTY
  `--method` and `--organization-id` (or `WIKI_ORGANIZATION_ID`) are required.
  `auth status` and `auth logout` manage the local file without a network call;
  `auth logout` needs `--yes` outside a TTY.
- **No `config` command** — there is nothing to configure.
- **No `--ai-access-check`** — not part of the Wiki API surface.
- **Cursor flags** (`--all`, `--cursor N`) are exposed on the read endpoints
  that return a `next_cursor` (`search`, `descendants`, `spaces`, comments,
  revisions). The comments and revisions cursors are **strings**, unlike the
  integer cursors elsewhere.
