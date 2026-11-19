# ywiki

CLI for **Yandex Wiki**, for people and agents. It owns its credential
(`~/.config/ywiki/credentials.toml`, schema v2) and its auth flow; refresh is
lazy and handled internally.

Read commands never change Wiki; writes use explicit `page …` subcommands.

Zero runtime dependencies. Node.js ≥ 20 (ESM, `.mjs`).

## Install

```bash
npm install -g .        # in a checkout of this repo; puts ywiki on PATH
ywiki auth login --method iam --organization-id <org>   # cloud/federated
ywiki whoami            # verify: login, scheme, org, credential age
```

In a TTY `auth login` prompts for a method (browser default); outside a TTY pass
`--method`. Cloud/federated accounts should use `--method iam`. See [Auth](#auth).

## Quick start

```bash
ywiki search "<term>"                        # find a page slug
ywiki page get <slug>                        # read it (clipped; continue with --offset N)
ywiki page history <slug>                    # revisions, newest first
ywiki page diff <slug> <from> <to>           # unified diff of two revisions
```

## Commands

```bash
# Reads
ywiki whoami
ywiki page get <slug> [--offset N] [--limit N] [--fields a,b]
ywiki page search <query> [--limit N] [--all] [--cursor N]
ywiki page descendants <slug> [--limit N] [--all] [--cursor N]
ywiki page locate <slug> <query>                 # ranges for --inline-range
ywiki page history <slug> [--limit N] [--all] [--ids a,b]
ywiki page revision <slug> <id> [--offset N] [--limit N]
ywiki page diff <slug> <from> <to> [--context N]
ywiki page comments <slug> [--limit N] [--all]   # alias of `page comment list`
ywiki page comment list <slug> [--thread ID] [--inline|--page-level] \
                                [--status resolved|unresolved] [--order asc|desc]
ywiki space list [--all]
ywiki api GET <path>                             # read-only passthrough

# Writes (no shortcuts; need --file | --stdin | --content; --dry-run sends nothing)
ywiki page create <slug> --title <t> [--content … | --file … | --stdin]
ywiki page edit   <slug> [--content … | --file … | --stdin] \
                         [--if-revision N] [--allow-merge] [--force]
ywiki page append <slug> (--content … | --file … | --stdin) \
                         [--at top|bottom] [--section ID] [--anchor NAME]
ywiki page delete <slug> [--recursive] [--yes]
ywiki page comment add    <slug> [text] [--inline-range START-END]
ywiki page comment reply  <slug> <thread-id> [text] [--to ID]
ywiki page comment delete <slug> <comment-id> [--yes]

# Auth / misc
ywiki auth login [--method browser|token|iam] [--organization-id ID] [--client-id ID]
ywiki auth status [--json]                       # local credential info, no network
ywiki auth logout --yes
ywiki skill                                      # bundled agent guidance
ywiki --help | --version
```

Flat shortcuts: `get` · `search` · `tree` · `spaces`.

Notes:

- `page edit` replaces the page content (it never opens `$EDITOR`); by default it
  sends the revision it read — `--if-revision N` pins another, `--force` allows
  last-write-wins.
- `page delete` prints a `recovery_token` for restore; without `--yes` it asks on
  a TTY and refuses when there is no input.
- Inline comments are two writes (the comment plus the `&[text](id)` marker);
  `--inline-range` is 0-based, end-exclusive, in Unicode code points — use
  `page locate` to find ranges.
- Read-only pages are refused (exit 4); `grid`/`cloud_page` edits are refused (exit 2).

## Output and flags

JSON when stdout is not a TTY (agents, pipes, CI); rich text on a TTY. `--json`
forces JSON; `--rich-ui=yes|no` overrides both ways. Global flags: `--json`,
`--rich-ui`, `--no-cache`, `--timeout-ms N` (alias `--timeout S`), `--no-input`.

Environment: `WIKI_IAM_TOKEN` / `WIKI_TOKEN` + `WIKI_ORGANIZATION_ID`, plus
`WIKI_CREDENTIALS`, `WIKI_OAUTH_CLIENT_ID`, `WIKI_CACHE_DIR`, `WIKI_NO_CACHE`,
`WIKI_BASE_URL`, `WIKI_YC_BIN`, `WIKI_YC_PROFILE`.

Exit codes: `0` ok · `2` usage · `3` unauthenticated · `4` access denied ·
`5` not found · `6` conflict · `8` unavailable. Full table and design rules:
[`docs/conventions.md`](docs/conventions.md).

## Auth

`ywiki` stores its own credential at `~/.config/ywiki/credentials.toml`
(schema v2, override with `WIKI_CREDENTIALS`); no other tool's file or timer is
involved.

```bash
ywiki auth login --method browser --organization-id <org> [--client-id ID]
ywiki auth login --method token   --organization-id <org>
ywiki auth login --method iam     --organization-id <org> [--yc-profile P]
```

- `browser` (default) — OAuth 2.0 + PKCE on `127.0.0.1`; needs a Wiki OAuth app
  client id (`--client-id` or `WIKI_OAUTH_CLIENT_ID`).
- `token` — paste an OAuth or IAM token on stdin or a hidden prompt.
- `iam` — run `yc --no-browser iam create-token` and store the result; the
  practical path for cloud and federated accounts.

On a `401`, `ywiki` makes one self-heal attempt for reads (IAM via
`yc iam create-token`, OAuth via its `refresh_token`); otherwise re-run
`ywiki auth login`. Writes are never replayed. The token is read in-process
only, never through `argv`, and is masked in all output. Details:
[`docs/runbook.md`](docs/runbook.md).

## Agents

Reads are safe to allow; every write lives under `ywiki page *`. A ready-made
OpenCode permission config (deny writes, allow reads) is in
[`docs/agent-permissions.md`](docs/agent-permissions.md). `ywiki skill` prints
bundled guidance.

## Tests

```bash
npm test        # offline: stub yc, injected fetch, tmp credential
```

## Docs

- [`docs/runbook.md`](docs/runbook.md) — operations, troubleshooting, token lifecycle.
- [`docs/wiki-api-notes.md`](docs/wiki-api-notes.md) — confirmed Wiki API surface.
- [`docs/conventions.md`](docs/conventions.md) — command shape, output modes, exit codes.
- [`docs/agent-permissions.md`](docs/agent-permissions.md) — OpenCode permission example.

## License

MIT — see [`LICENSE`](LICENSE).
