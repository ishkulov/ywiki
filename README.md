# ywiki

CLI for **Yandex Wiki**, for people and agents. It owns its credential
(`~/.config/ywiki/credentials.toml`, schema v2) and its auth flow; refresh is
lazy and handled internally. Reads never change Wiki; Wiki writes exist only as
explicit `page …` subcommands. Zero dependencies; Node.js ≥ 20.

## Install

```bash
npm install -g @ishkulov/ywiki    # from the npm registry; installs the `ywiki` command
ywiki auth login                  # obtain and store a credential (see Auth)
ywiki whoami                      # verify: login, scheme, org, credential age
```

From a checkout instead of the registry:

```bash
git clone https://github.com/ishkulov/ywiki.git && cd ywiki
npm install -g .        # puts ywiki on PATH
```

See [Auth](#auth) for login methods and the organization id.

## Quick start

```bash
ywiki search "<term>"                        # find a page slug
ywiki page get <slug>                        # read it (clipped; continue with --offset N)
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
ywiki page comment list <slug> [--thread ID] [--inline|--page-level] \
                               [--status resolved|unresolved] [--order asc|desc]
ywiki space list [--all]
ywiki api GET <path> [--header "Name: value"]    # read-only passthrough

# Writes (no shortcuts; text from --file | --stdin | --content; --dry-run sends nothing)
ywiki page create <slug> --title <t> [--content … | --file … | --stdin]
ywiki page edit   <slug> [--content … | --file … | --stdin] [--title t] \
                         [--if-revision N] [--allow-merge] [--force]
ywiki page append <slug> (--content … | --file … | --stdin) \
                         [--at top|bottom] [--section ID] [--anchor NAME]
ywiki page delete <slug> [--recursive] [--yes]
ywiki page comment add    <slug> [text] [--inline-range START-END]
ywiki page comment reply  <slug> <thread-id> [text] [--to ID]
ywiki page comment delete <slug> <comment-id> [--yes]

# Auth / misc
ywiki auth login|status|logout                   # local credential; see Auth
ywiki skill                                      # bundled agent guidance
ywiki --help | --version
```

Flat shortcuts: `get` · `search` · `tree` · `spaces`; `page comments` is an
alias of `page comment list`.

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
`--rich-ui`, `--no-cache`, `--timeout-ms N` (alias `--timeout S`), `--no-input`;
writes also accept `--silent`, and `api` accepts `--header`.

Environment: `WIKI_IAM_TOKEN` / `WIKI_TOKEN` + `WIKI_ORGANIZATION_ID`, plus
`WIKI_CREDENTIALS`, `WIKI_OAUTH_CLIENT_ID`, `WIKI_CACHE_DIR`, `WIKI_NO_CACHE=1`,
`WIKI_BASE_URL`, `WIKI_YC_BIN`, `WIKI_YC_PROFILE`.

Exit codes: `0` ok · `2` usage · `3` unauthenticated · `4` access denied ·
`5` not found · `6` conflict · `8` unavailable · `130` interrupted
(Ctrl+C/Ctrl+D at a prompt). Full table and design rules:
[`docs/conventions.md`](docs/conventions.md).

## Auth

`ywiki` stores its own credential at `~/.config/ywiki/credentials.toml`
(schema v2, override with `WIKI_CREDENTIALS`); no other tool's file or timer is
involved. In a TTY, plain `ywiki auth login` asks for the method (browser
default) and the organization id; outside a TTY pass `--method` and
`--organization-id` (or `WIKI_ORGANIZATION_ID`). `auth status` prints the local
credential without a network call; `auth logout --yes` removes only the local
file.

```bash
ywiki auth login --method browser --organization-id <org> [--client-id ID]
ywiki auth login --method token   --organization-id <org>
ywiki auth login --method iam     --organization-id <org> [--yc-profile P]
```

The organization id is not discoverable offline: it is the `b1g…` id from the
Yandex Cloud console, or a numeric id for Yandex 360 for Business
(Tracker → Администрирование → Организации).

- `browser` (the TTY default) — OAuth 2.0 + PKCE on `127.0.0.1`; uses the
  bundled CLI OAuth app. Override the app id with `--client-id` or
  `WIKI_OAUTH_CLIENT_ID` (for a private app, create it at
  <https://oauth.yandex.ru> with `wiki:read`/`wiki:write`). The bundled app
  belongs to a work account; a cloud organization may refuse its OAuth token —
  then use `--method iam` or `--method token`.
- `token` — paste an OAuth or IAM token on stdin or a hidden prompt.
- `iam` — run `yc --no-browser iam create-token` and store the result; the
  practical path for cloud and federated accounts.

On a `401`, `ywiki` makes one self-heal attempt for reads (IAM via
`yc iam create-token`, OAuth via its `refresh_token`); otherwise re-run
`ywiki auth login`. Writes are never replayed. The token is read in-process
only, never through `argv`, and is masked in all output. Details:
[`docs/runbook.md`](docs/runbook.md).

## Agents

Reads are safe to allow; every Wiki write lives under `ywiki page *`. A
ready-made OpenCode permission config (deny writes, allow reads) is in
[`docs/agent-permissions.md`](docs/agent-permissions.md). `ywiki skill` prints
bundled guidance.

## Tests

```bash
npm test        # offline; no network
```

More docs: [`runbook.md`](docs/runbook.md) — operations and token lifecycle ·
[`wiki-api-notes.md`](docs/wiki-api-notes.md) — confirmed API surface ·
[`conventions.md`](docs/conventions.md) — command shape and exit codes ·
[`agent-permissions.md`](docs/agent-permissions.md) — OpenCode permissions ·
[`CHANGELOG.md`](CHANGELOG.md) — release history ·
[`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute.

## License

MIT — see [`LICENSE`](LICENSE).
