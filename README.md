# ywiki

CLI for **Yandex Wiki**, for people and agents. It reuses the existing legacy IAM
credential (`~/.config/legacy/legacy/credentials.toml`, schema v2) and the
`the legacy refresh helper` refresh timer — it does **not** create a second credential,
timer, or token source.

Reads are the default. Mutations are explicit and confined to the page and
comment commands (`page create|edit|append|delete`, `page comment
add|reply|delete`); there are no write shortcuts.

Zero runtime dependencies. Node.js ≥ 20 (ESM, `.mjs`).

## Install

From the repository (global install, no registry):

```bash
npm install -g .            # in a checkout of this repo
# or
npm install -g <git-url>
```

That puts a `ywiki` executable on `PATH` (nvm's global bin). Verify:

```bash
ywiki whoami
```

## Usage

`ywiki` follows the `the legacy CLI` CLI conventions: grouped commands with flat
shortcuts, JSON output by default when piped, rich text on a terminal.

```bash
ywiki whoami                        # login, scheme, org, credential age, token prefix
ywiki page get <slug> [--offset N] [--limit N] [--fields a,b]
ywiki page search <query> [--limit N] [--all] [--cursor N]
ywiki page descendants <slug> [--limit N] [--all] [--cursor N]
ywiki page locate <slug> <query> [--limit N]      # ranges for --inline-range
ywiki page history <slug> [--limit N] [--all] [--ids a,b]   # revisions, newest first
ywiki page revision <slug> <id> [--offset N] [--limit N]    # read one revision
ywiki page comments <slug> [--limit N] [--all]    # alias of page comment list
ywiki page comment list <slug> [--thread ID] [--inline|--page-level] \
                                [--status resolved|unresolved] [--order asc|desc]
ywiki space list [--all]
ywiki api GET <path> [--header "Name: value"]   # read-only passthrough
ywiki skill                          # bundled agent guidance
ywiki --help | --version
```

Shortcuts: `get <slug>` · `search <query>` · `tree <slug>` · `spaces`.

### History

```bash
ywiki page history <slug> [--limit N] [--all] [--cursor C] [--ids a,b]
ywiki page revision <slug> <revision-id> [--offset N] [--limit N]
```

- `page history` lists revisions newest first and marks the current one
  `← current`. `--limit` is the API `page_size` (1–50); `--cursor` is a string,
  so `--all` follows `next_cursor` until exhausted.
- `page revision` reads one revision's content, clipped like `page get`
  (`--offset` continues a long page). An unknown revision id exits `5`.
- Both are reads: they never change the page or its revision.

### Writing

Mutations are separate commands and have **no** shortcuts. Each needs an
explicit content source: `--file <path>`, `--stdin`, or `--content <text>`.

```bash
ywiki page create <slug> --title <title> [--content … | --file … | --stdin] [--silent] [--dry-run]
ywiki page edit   <slug> [--content … | --file … | --stdin] [--title <t>] \
                         [--if-revision N] [--allow-merge] [--force] [--silent] [--dry-run]
ywiki page append <slug> (--content … | --file … | --stdin) \
                         [--at top|bottom] [--section ID] [--anchor NAME] \
                         [--anchor-regex] [--anchor-fallback] [--silent] [--dry-run]
ywiki page delete <slug> [--recursive] [--yes] [--dry-run]
```

- `page edit` replaces the page content; it never opens `$EDITOR`.
- By default the request carries the revision it read (`--if-revision` to pin a
  different one, `--force` to omit it and allow last-write-wins).
- `--dry-run` prints what would be sent (a diff for `edit`) and sends nothing.
- `page delete` without `--yes` asks for confirmation on a TTY and refuses when
  there is no input; it prints the `recovery_token` needed to restore the page.
- Read-only pages (`attributes.is_readonly`) are refused (exit 4); content edits
  on `grid`/`cloud_page` pages are refused (exit 2).

### Comments

```bash
ywiki page comment add    <slug> [text] [--file … | --stdin | --content …] [--dry-run]
ywiki page comment add    <slug> [text] --inline-range START-END [--dry-run]
ywiki page comment reply  <slug> <thread-id> [text] [--to ID] [--dry-run]
ywiki page comment delete <slug> <comment-id> [--yes] [--dry-run]
```

- `page comment list --thread <id>` lists replies; without `--thread` it lists
  top-level comments. `--inline` / `--page-level` filter by anchor.
- `--inline-range START-END` is 0-based and end-exclusive, counted in Unicode
  code points. Use `page locate` to find ranges. The comment text is the
  anchored fragment; `inline_text` is metadata.
- An inline comment is two writes: create the comment, then edit the page with
  the `&[text](id)` marker. If the page edit fails, the comment is deleted.
  Deleting an inline comment also removes its marker.
- `page comment delete` without `--yes` asks for confirmation on a TTY and
  refuses when there is no input.

Global flags: `--json`, `--rich-ui=yes|no`, `--no-cache`,
`--timeout-ms N` (alias `--timeout S`), `--no-input`.
Environment: `LEGACY_CREDENTIALS`, `LEGACY_AUTH`, `WIKI_CACHE_DIR`, `WIKI_NO_CACHE`,
`LEGACY_IAM_TOKEN`, `LEGACY_ORGANIZATION_ID` (and `WIKI_*` aliases),
`WIKI_BASE_URL`.

Output: JSON when stdout is not a TTY (agents, pipes, CI); rich text on a TTY.
`--json` forces JSON, `--rich-ui=yes|no` overrides both ways.

Exit codes (aligned with `the legacy CLI`):

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | — |
| 2 | usage | fix the command from the hint |
| 3 | unauthenticated | refresh the token (see below) |
| 4 | access_denied | **do not retry**; ask the page owner |
| 5 | not_found | try another slug or `search` |
| 6 | conflict | version changed or index warming up; re-read and retry |
| 8 | unavailable | retry later; after a write, re-read the page first |

## Agent permissions

Because every mutation lives under `ywiki page <verb>`, one deny-all rule plus
per-read allow rules is enough. In OpenCode, the last matching rule wins:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "ywiki *", "effect": "ask" },
    { "action": "shell", "resource": "ywiki page *", "effect": "deny" },
    { "action": "shell", "resource": "ywiki page get *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page search *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page descendants *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page locate *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page history *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page revision *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page comments *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki page comment list *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki get *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki search *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki tree *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki spaces *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki space *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki api GET *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki whoami *", "effect": "allow" },
    { "action": "shell", "resource": "ywiki skill *", "effect": "allow" }
  ]
}
```

`deny` keeps an agent read-only; `ask` (or `allow`) permits edits after review.
A new read verb without its own rule is denied — the split fails closed.

## Auth

Auth is delegated to the existing infrastructure:

- Credential: `~/.config/legacy/legacy/credentials.toml` (override with `LEGACY_CREDENTIALS`).
- Header: `Authorization: Bearer <IAM>`; org id goes to `X-Cloud-Org-Id`
  (numeric org → `X-Org-Id`).
- On a `401`, `ywiki` performs **one** self-heal: it runs
  `the legacy refresh helper --refresh` (override with `LEGACY_AUTH`), then retries. Refreshes
  are serialised across processes (lock file) with a 60 s cooldown.

The token is read from the file in-process only, is never passed through
`argv`, and is masked everywhere it could appear in output or logs.

## Tests

Offline — the real credential is never read, and the real `the legacy refresh helper` is
never executed (stubs via `LEGACY_AUTH`):

```bash
npm test
# or: node --test 'test/*.test.mjs'
```

> Node 24's `node --test test/` (directory argument) is broken — it treats the
> directory as a module. Use the quoted glob form, as in `package.json`.

## Docs

- [`docs/runbook.md`](docs/runbook.md) — operations, troubleshooting, token lifecycle.
- [`docs/wiki-api-notes.md`](docs/wiki-api-notes.md) — Wiki API surface
  (read and write endpoints confirmed live).
- [`docs/compat.md`](docs/compat.md) — the legacy CLI ↔ ywiki convention mapping.
- [`docs/plan.md`](docs/plan.md) — the original v2 build plan (historical).

## Safety

- Reads are the default. Mutations go only through `ywiki page create|edit|append|delete`
  and `ywiki page comment add|reply|delete` (no shortcuts); `ywiki api` stays
  `GET`-only, so writes cannot slip through a read prefix.
- Writes are never retried automatically: a timeout or `5xx` on a write means the
  outcome is unknown — re-read the page before retrying.
- Never read the credential file directly and never call the Wiki API with
  `curl`; keep the token inside `ywiki`.
- Never invent a slug — `ywiki search` first, then cite the slug you used.

## License

MIT — see [`LICENSE`](LICENSE).
