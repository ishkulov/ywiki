# Runbook: `ywiki` — Yandex Wiki access

`ywiki` is a zero-dependency Node CLI for Yandex Wiki. It reuses the **existing**
legacy IAM credential and the **existing** `the legacy refresh helper` timer; it does not create
a second credential, timer, or token source. Reads are the default; mutations go
only through the explicit `page create|edit|append|delete` and
`page comment add|reply|delete` commands.

## Install

```bash
npm install -g .          # from a checkout of this repo
ywiki whoami              # verify: login, scheme=iam, org, token prefix
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
```

- `--limit` is the API `page_size` (1–50); the revisions cursor is a **string**,
  so `--cursor` takes a `next_cursor` value verbatim.
- `page revision` clips long content exactly like `page get`; continue with
  `--offset N`.
- History is read-only. There is no diff/restore subcommand: compare by reading
  two revisions; restore by `page edit --file …` with the old content.

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

Exit codes (aligned with `the legacy CLI`): `0` ok · `2` usage · `3` auth required ·
`4` access denied (do not retry) · `5` not found · `6` conflict · `8`
unavailable (retry later).

## Token lifecycle

Wiki uses the same IAM token as Tracker (`Bearer`, `X-Cloud-Org-Id`), refreshed
by `the legacy refresh helper.timer` every 10 h (TTL ~12 h). Nothing extra to run.

- On a `401`, `ywiki` runs **one** self-heal: `the legacy refresh helper --refresh`
  (which only updates the credential; no Tracker call, no browser), then retries.
- Refreshes are serialised across processes (lock file) with a 60 s cooldown.
- If a read returns exit `3` (unauthenticated), refresh the token manually:

```bash
the legacy refresh helper --refresh
```

## Verify / troubleshoot

```bash
npm test                  # full suite (offline; stub LEGACY_AUTH)
ywiki whoami              # identity + credential age + token prefix
ywiki spaces              # quick read-only reachability check
systemctl --user status the legacy refresh helper.timer --no-pager   # timer state
```

- Exit `3` with a fresh credential → check the timer; it may have failed.
- Exit `4` → the signed-in user genuinely lacks access; do not retry, ask the
  page owner.
- Exit `6` → version conflict or index warming up (`ALREADY_INDEXING`); for a
  write, re-read the page and retry; for a search, retry shortly.
- Exit `8` after a write → the request may have been applied; re-read the page
  before retrying. Writes are never replayed automatically.
- Cache lives in `~/.cache/legacy/wiki/` (TTL 60 s; `WIKI_NO_CACHE=1` disables it;
  `WIKI_CACHE_DIR` relocates it).

## Environment overrides

| Variable | Effect |
|---|---|
| `LEGACY_CREDENTIALS` | credential file path (default `~/.config/legacy/legacy/credentials.toml`) |
| `LEGACY_AUTH` | refresh script path (default `~/.local/bin/the legacy refresh helper`) |
| `WIKI_CACHE_DIR` | cache directory |
| `WIKI_NO_CACHE=1` | disable the disk cache |
| `LEGACY_IAM_TOKEN`, `LEGACY_ORGANIZATION_ID` | use these instead of the file (same vars as `the legacy CLI`) |
| `WIKI_IAM_TOKEN`, `WIKI_ORGANIZATION_ID` | fallback aliases for the above |
| `WIKI_BASE_URL` | API base (tests) |

## Safety rules

- Never read `~/.config/legacy/legacy/credentials.toml` directly and never call the
  Wiki API via `curl`; the token stays inside `ywiki`.
- Never invent a slug — `ywiki search` first, then cite the slug you used.
