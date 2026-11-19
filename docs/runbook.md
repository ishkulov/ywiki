# Runbook: `ywiki` — read-only Yandex Wiki access

`ywiki` is a zero-dependency Node CLI for reading Yandex Wiki. It reuses the
**existing** legacy IAM credential and the **existing** `the legacy refresh helper` timer; it
does not create a second credential, timer, or token source, and it never writes
to Wiki.

## Install

```bash
npm install -g .          # from a checkout of this repo
ywiki whoami              # verify: login, scheme=iam, org, token prefix
```

Requires Node.js ≥ 20 (on `PATH`; nvm's global bin). No `npm install`
dependencies, no `bun`.

## Daily use

```bash
ywiki search "<term>"     # find pages -> "slug — title"
ywiki get <slug>          # read a page (clipped; continue with --offset N)
ywiki tree <slug>         # list sub-pages
ywiki spaces              # list spaces
```

Exit codes: `0` ok · `2` usage · `3` not found · `4` access denied (do not
retry) · `5` upstream (retry later) · `8` auth expired.

## Token lifecycle

Wiki uses the same IAM token as Tracker (`Bearer`, `X-Cloud-Org-Id`), refreshed
by `the legacy refresh helper.timer` every 10 h (TTL ~12 h). Nothing extra to run.

- On a `401`, `ywiki` runs **one** self-heal: `the legacy refresh helper --refresh`
  (which only updates the credential; no Tracker call, no browser), then retries.
- Refreshes are serialised across processes (lock file) with a 60 s cooldown.
- If a read returns exit `8`, refresh the token manually:

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

- Exit `8` with a fresh credential → check the timer; it may have failed.
- Exit `4` → the signed-in user genuinely lacks access; do not retry, ask the
  page owner.
- Cache lives in `~/.cache/legacy/wiki/` (TTL 60 s; `WIKI_NO_CACHE=1` disables it;
  `WIKI_CACHE_DIR` relocates it).

## Environment overrides

| Variable | Effect |
|---|---|
| `LEGACY_CREDENTIALS` | credential file path (default `~/.config/legacy/legacy/credentials.toml`) |
| `LEGACY_AUTH` | refresh script path (default `~/.local/bin/the legacy refresh helper`) |
| `WIKI_CACHE_DIR` | cache directory |
| `WIKI_NO_CACHE=1` | disable the disk cache |
| `WIKI_IAM_TOKEN`, `WIKI_ORGANIZATION_ID` | use these instead of the file |
| `WIKI_BASE_URL` | API base (tests) |

## Safety rules

- Never read `~/.config/legacy/legacy/credentials.toml` directly and never call the
  Wiki API via `curl`; the token stays inside `ywiki`.
- Never invent a slug — `ywiki search` first, then cite the slug you used.
