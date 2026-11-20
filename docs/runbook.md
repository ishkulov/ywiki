# Runbook: `ywiki` — Yandex Wiki access

`ywiki` is a zero-dependency Node CLI for Yandex Wiki. It owns its credential
(`~/.config/ywiki/credentials.toml`) and its refresh path. Reads are the default;
mutations go only through the explicit `page create|edit|append|delete` and
`page comment add|reply|delete` commands.

## Install

```bash
npm install -g .          # from a checkout of this repo
ywiki auth login --method iam --organization-id <org>   # cloud/federated
ywiki whoami              # verify: login, scheme, org, token prefix
```

Requires Node.js ≥ 20 (on `PATH`; nvm's global bin). No `npm install`
dependencies, no `bun`.

## Daily use

```bash
ywiki page search "<term>" # find pages (JSON when piped; --rich-ui=yes for text)
ywiki page get <slug>      # read a page (clipped; continue with --offset N)
ywiki page descendants <slug>  # list sub-pages
ywiki page locate <slug> "<text>"  # find ranges for inline comments
ywiki page history <slug>      # revisions, newest first
ywiki page revision <slug> <id>  # content of one revision
ywiki page comments <slug>     # top-level comments (alias of page comment list)
ywiki page comment list <slug> --thread <id>  # replies in a thread
ywiki space list           # list spaces
ywiki search "<term>"      # shortcuts: get / search / tree / spaces
```

### History

```bash
ywiki page history <slug> --limit 20       # newest first; --all pages the rest
ywiki page history <slug> --ids 123,456    # only these revisions
ywiki page revision <slug> 123             # content of one revision
ywiki page diff <slug> 122 123             # unified diff, 3 lines of context
ywiki page diff <slug> 122 123 --context 0 # only changed lines
```

- `--limit` is the API `page_size` (1–50); the revisions cursor is a **string**,
  so `--cursor` takes a `next_cursor` value verbatim.
- `page revision` clips long content exactly like `page get`; continue with
  `--offset N`.
- `page diff` compares locally (no diff endpoint in the API) with `--context`
  0–50 (default 3). A very large page falls back to a block comparison and the
  JSON says `coarse: true`.
- History is read-only. To restore an old revision, `page edit --file …` with
  its content (there is no restore subcommand).

### Editing pages

```bash
ywiki page create <slug> --title "…" --file page.md
ywiki page edit <slug> --file page.md           # replaces the content
ywiki page append <slug> --file add.md --at bottom
ywiki page delete <slug> --yes                  # prints recovery_token
```

- Pass the new text explicitly (`--file`, `--stdin`, `--content`); no `$EDITOR`.
- `--dry-run` prints what would be sent (a diff for `edit`) and sends nothing.
- `--if-revision N` pins the base revision; `--force` omits it (last-write-wins).
- Read-only pages are refused (exit 4); `grid`/`cloud_page` content edits are
  refused (exit 2).
- Writes are **not** retried. A timeout or `5xx` means the outcome is unknown:
  re-read the page (`ywiki page get <slug>`) before retrying.
- `page delete` prints a `recovery_token`; restore with
  `POST /v1/recovery_tokens/<token>/recover` (not exposed as a subcommand yet).

### Editing comments

```bash
ywiki page comment add <slug> "text"                    # page-level
ywiki page comment add <slug> "text" --inline-range 42-54
ywiki page comment reply <slug> <thread-id> "text" [--to <comment-id>]
ywiki page comment delete <slug> <comment-id> --yes
```

- `--inline-range START-END` is 0-based and end-exclusive, counted in Unicode
  code points. Use `ywiki page locate <slug> "<text>"` to find a range.
- An inline comment is two writes: create the comment, then edit the page with
  the `&[text](id)` marker. If the page edit fails, the comment is deleted; the
  command reports the rollback. Deleting an inline comment removes its marker.
- `reply` needs the **root** comment id as `thread-id`; `--to` targets a reply
  inside that thread. `parent_id` alone does not attach a reply to a thread.
- Writes are not retried. If a page edit fails after the comment was created,
  re-read the page and check for the comment before retrying.
- The API has no resolve/unresolve endpoint; `ywiki` does not expose one.

Output is JSON when stdout is not a terminal (agents, pipes, CI) and rich text
on a terminal; `--json` / `--rich-ui=yes|no` override.

Exit codes: `0` ok · `2` usage · `3` auth required ·
`4` access denied (do not retry) · `5` not found · `6` conflict · `8`
unavailable (retry later).

## Token lifecycle

`ywiki` owns its credential and refresh path. There is no timer: refresh is lazy
and triggered by a `401` on an idempotent read.

- Credential: `~/.config/ywiki/credentials.toml` (schema v2, mode `0600`).
- IAM (`scheme=iam`): renewed with `yc --no-browser iam create-token`.
- OAuth (`scheme=oauth`): renewed with the stored `refresh_token` when present;
  otherwise `ywiki auth login` is required.
- Refreshes are single-flight across processes (lock file) and cooldown-guarded
  (60 s). A failed refresh leaves the old credential in place.
- `ywiki auth logout --yes` removes only the local file. Outside a TTY, `--yes`
  is required; the server-side token remains valid until it expires.
- If a read returns exit `3` (unauthenticated), refresh manually:

```bash
ywiki auth login --method iam --organization-id <org>   # or --method browser/token
```

### Login methods

- `browser` — OAuth 2.0 Authorization Code + PKCE. Callback ports `21332`,
  `24816`, `28934`; path `/callback`. The token request does not send
  `redirect_uri`, matching the browser login flow. Needs a Wiki OAuth app client id.
- `token` — paste an OAuth or IAM token on stdin or a hidden TTY prompt. Prints
  the token page when a client id is configured, otherwise a generic OAuth link
  and IAM instructions.
- `iam` — `yc --no-browser iam create-token`, validated against `GET /users/me`.

In a TTY, `auth login` asks for a method (browser default) and for the
organization id when neither `--organization-id` nor `WIKI_ORGANIZATION_ID` is
set. Outside a TTY the method comes from `--method` and the org id from the flag
or `WIKI_ORGANIZATION_ID`. The browser flow uses a bundled OAuth app id;
override it with `--client-id` or `WIKI_OAUTH_CLIENT_ID` (a private app needs
the `wiki:read`/`wiki:write` scopes). The bundled app is a public CLI client
(no secret, PKCE, loopback redirect): client id `574f967087084ad4a156cd54f4651706`
with redirects `http://127.0.0.1:{21332,24816,28934}/callback`. It belongs to a
work account — if it is ever replaced, update `DEFAULT_OAUTH_CLIENT_ID`
(`lib/auth.mjs`) and ship a new version. For a cloud organization the OAuth page
may not work; then use `--method iam` or paste an IAM token with `--method
token`. An IAM token lives about 12 hours and is refreshed lazily.

## Verify / troubleshoot

```bash
npm test                  # full suite (offline; stub yc via WIKI_YC_BIN)
ywiki auth status         # local credential: path, scheme, org, age, token prefix
ywiki whoami              # identity + credential age + token prefix
ywiki spaces              # quick read-only reachability check
```

- Exit `3` with a fresh credential → the token is invalid or expired; run
  `ywiki auth login` again. Check `ywiki auth status` first.
- Exit `4` → the signed-in user genuinely lacks access; do not retry, ask the
  page owner.
- Exit `6` → version conflict or index warming up (`ALREADY_INDEXING`); for a
  write, re-read the page and retry; for a search, retry shortly.
- Exit `8` after a write → the request may have been applied; re-read the page
  before retrying. Writes are never replayed automatically.
- Exit `130` → input was interrupted (Ctrl+C/Ctrl+D at a prompt); nothing was
  written. Run the command again when ready.
- Cache lives in `~/.cache/ywiki/` (TTL 60 s; `WIKI_NO_CACHE=1` disables it;
  `WIKI_CACHE_DIR` relocates it).

## Environment overrides

| Variable | Effect |
|---|---|
| `WIKI_CREDENTIALS` | credential file path (default `~/.config/ywiki/credentials.toml`) |
| `WIKI_IAM_TOKEN` | IAM token; overrides the file (scheme=iam) |
| `WIKI_TOKEN` | OAuth token; overrides the file (scheme=oauth) |
| `WIKI_ORGANIZATION_ID` | organization id for ENV tokens |
| `WIKI_OAUTH_CLIENT_ID` | override the bundled OAuth client id for browser/token login |
| `WIKI_CACHE_DIR` | cache directory |
| `WIKI_NO_CACHE=1` | disable the disk cache |
| `WIKI_BASE_URL` | API base (tests) |
| `WIKI_YC_BIN` | `yc` binary (default `yc`; tests use a stub) |
| `WIKI_YC_PROFILE` | `yc` profile for `iam create-token` |

`WIKI_*` variables are the only ones read.

## Safety rules

- Never read `~/.config/ywiki/credentials.toml` directly and never call the Wiki
  API via `curl`; the token stays inside `ywiki`.
- Never invent a slug — `ywiki search` first, then cite the slug you used.
