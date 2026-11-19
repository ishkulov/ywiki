# ywiki

Read-only CLI for **Yandex Wiki**, for people and agents. It reuses the existing
legacy IAM credential (`~/.config/legacy/legacy/credentials.toml`, schema v2) and the
`the legacy refresh helper` refresh timer — it does **not** create a second credential,
timer, or token source, and it never writes to Wiki.

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

```bash
ywiki whoami                       # login, scheme, org, credential age, token prefix
ywiki get <slug> [--offset N] [--limit N]
ywiki search <query> [--limit N]
ywiki tree <slug> [--limit N]
ywiki spaces
ywiki --help | --version
```

Global flags: `--json`, `--no-cache`, `--timeout S`.
Environment: `LEGACY_CREDENTIALS`, `LEGACY_AUTH`, `WIKI_CACHE_DIR`, `WIKI_NO_CACHE`,
`WIKI_IAM_TOKEN`, `WIKI_ORGANIZATION_ID`, `WIKI_BASE_URL`.

Exit codes:

| Code | Meaning | What to do |
|---|---|---|
| 0 | ok | — |
| 2 | usage | fix the command from the hint |
| 3 | not_found | try another slug or `search` |
| 4 | access_denied | **do not retry**; ask the page owner |
| 5 | upstream_unavailable | retry later |
| 8 | auth_unavailable | refresh the token (see below) |

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
- [`docs/wiki-api-notes.md`](docs/wiki-api-notes.md) — confirmed Wiki API
  surface (endpoints, headers, error taxonomy) from live reconnaissance.
- [`docs/plan.md`](docs/plan.md) — the original v2 build plan (historical).

## Safety

- Read-only. The only non-GET call is `POST /search` (a read operation).
- Never read the credential file directly and never call the Wiki API with
  `curl`; keep the token inside `ywiki`.
- Never invent a slug — `ywiki search` first, then cite the slug you used.

## License

MIT — see [`LICENSE`](LICENSE).
