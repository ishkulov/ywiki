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
| Commands | grouped (`issue view`, `queue list`) | `page get/search/descendants`, `space list` + shortcuts `get/search/tree/spaces` |
| Default output | JSON when piped, ANSI on TTY | same (`--json` / `--rich-ui=yes\|no`) |
| Help | `$ cmd` example + annotation, `Usage`/`Commands`/`Options` | same |
| Errors | `Error: <Title>` / detail / `Next:` | same |
| Credential | `~/.config/legacy/<profile>/credentials.toml` (v2), `scheme=iam` | same file, never written |
| Env token | `LEGACY_IAM_TOKEN` + `LEGACY_ORGANIZATION_ID` | same first, `WIKI_*` as aliases |
| Refresh | on-demand; `auth login --method token` | reuse the `the legacy refresh helper` timer; one `--refresh` self-heal on 401 |
| Passthrough | `api <method> <path>` | `api GET <path>` (read-only subset only) |
| Agent guidance | `skill` | `skill` |
| Extra | `--dry-run`, `--no-input`, `--ai-access-check` | `--no-input` accepted; no mutations, so no dry-run/ai-check |

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

- **Read-only.** `ywiki` has no mutating subcommands; `api` accepts only `GET`
  and only the confirmed Wiki surface (`pages`, `spaces`, `users/me`, `search`).
- **`config`** does not exist (nothing to configure for read-only access).
- **No `--dry-run` / `--ai-access-check`** — they guard writes / AI policy that
  `ywiki` does not perform.
- **Cursor flags** (`--all`, `--cursor N`) are exposed on the read endpoints
  that return a `next_cursor` (`search`, `descendants`, `spaces`).
