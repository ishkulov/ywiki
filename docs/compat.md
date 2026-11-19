# the legacy CLI ↔ ywiki compatibility

`ywiki` mirrors the `the legacy CLI` CLI so people and agents can treat both the same
way. This file records the mapping and the intentional differences.

## Runtime (reference)

`the legacy CLI` is not a Go/Rust binary: it is a **Bun single-file executable**
(`bun build --compile`, Bun ≥ 1.3, ≈95 MB) whose source is TypeScript/JS, with a
**citty**-style command tree. Distribution is `curl …/install.sh | sh` into
`~/.local/bin`, self-updated from `…/the legacy CLI-cli/release/stable`.

`ywiki` deliberately stays on **Node ≥ 20, ESM, zero dependencies** (see
`AGENTS.md`); only the *conventions* are shared, not the stack.

## Conventions

| Aspect | the legacy CLI | ywiki |
|---|---|---|
| Commands | grouped (`issue view`, `queue list`) | `page get/search/descendants/locate/history/revision/diff/comments`, `page comment list`, `space list` + shortcuts `get/search/tree/spaces`; writes: `page create/edit/append/delete`, `page comment add/reply/delete` |
| Default output | JSON when piped, ANSI on TTY | same (`--json` / `--rich-ui=yes\|no`) |
| Help | `$ cmd` example + annotation, `Usage`/`Commands`/`Options` | same |
| Errors | `Error: <Title>` / detail / `Next:` | same |
| Credential | `~/.config/legacy/<profile>/credentials.toml` (v2), `scheme=iam` | same file, never written |
| Env token | `LEGACY_IAM_TOKEN` + `LEGACY_ORGANIZATION_ID` | same first, `WIKI_*` as aliases |
| Refresh | on-demand; `auth login --method token` | reuse the `the legacy refresh helper` timer; one `--refresh` self-heal on 401 |
| Passthrough | `api <method> <path>` | `api GET <path>` (read-only subset only) |
| Writes | `issue create/edit`, `--dry-run` | `page create/edit/append/delete`, `page comment add/reply/delete`; `--dry-run` on all |
| Agent guidance | `skill` | `skill` |
| Short flags | `-h`/`--help`, `-v`/`--version [--json]` | same (`-v` prints one line; JSON on `--json`) |
| Extra | `--dry-run`, `--no-input`, `--ai-access-check` | `--dry-run`, `--no-input`; no `--ai-access-check` |

## Exit codes (identical)

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

## Intentional differences

- **Writes are explicit and gated.** Mutations exist only as `page create|edit|
  append|delete` and `page comment add|reply|delete`, with no shortcuts, so a
  permission rule on the single prefix covers the whole write surface. `api`
  accepts only `GET` and only the confirmed Wiki surface (`pages`, `spaces`,
  `users/me`, `search`).
- **Writes are never replayed.** A timeout or `5xx` on a write is reported as
  `unavailable` without a retry; the caller must re-read the page.
- **`config`** does not exist (nothing to configure).
- **No `--ai-access-check`** — not part of the Wiki API surface.
- **Cursor flags** (`--all`, `--cursor N`) are exposed on the read endpoints
  that return a `next_cursor` (`search`, `descendants`, `spaces`, comments,
  revisions). The comments and revisions cursors are **strings**, unlike the
  integer cursors elsewhere.
