# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.3] - 2026-11-20

### Changed

- Published on npm as **`@ishkulov/ywiki`** (`npm install -g @ishkulov/ywiki`);
  the `ywiki` command and the GitHub repository name are unchanged. The
  unscoped `ywiki` name was rejected by npm as too similar to an existing
  package.
- Publishing now runs from GitHub Actions with npm Trusted Publishing (OIDC)
  and provenance; no npm token is stored in the repository.

## [0.7.2] - 2026-11-20

First public release. Zero-dependency Node CLI for Yandex Wiki: reads by
default, explicit writes, and its own credential with lazy refresh.

### Added

- Read commands: `whoami`, `page get|search|descendants|locate|history|revision|diff`,
  `page comment list`, `space list`, and the flat shortcuts
  `get` · `search` · `tree` · `spaces`. Full-text search and a tree walk built on
  `GET /v1/pages/descendants`; `page diff` compares two revisions locally with a
  unified diff (`--context 0–50`, coarse fallback for very large pages).
- Explicit write commands: `page create|edit|append|delete` and
  `page comment add|reply|delete`. All writes have `--dry-run` and no shortcuts,
  so a single permission rule on the `page` prefix gates the whole write surface.
  Inline comments are two writes (comment + `&[text](id)` marker), with rollback
  on a failed page edit.
- Auth: `auth login|status|logout` with `browser` (OAuth 2.0 + PKCE on
  `127.0.0.1`), `token` (paste OAuth/IAM), and `iam`
  (`yc --no-browser iam create-token`) methods. Own credential at
  `~/.config/ywiki/credentials.toml` (schema v2, mode `0600`) and lazy,
  single-flight `401` self-heal — no timer and no second token source.
- Bundled public CLI OAuth app id for `browser` login (overridable with
  `--client-id` / `WIKI_OAUTH_CLIENT_ID`); IAM is the recommended path for
  cloud/federated organizations.
- `skill` output with bundled agent guidance, and a ready-made OpenCode
  read-only permission config in `docs/agent-permissions.md`.
- Read-only `api GET <path>` passthrough over the confirmed Wiki surface.

### Behavior

- Output is JSON when stdout is not a TTY and rich text on a TTY; `--json` and
  `--rich-ui=yes|no` override.
- Exit codes: `0` ok · `2` usage · `3` unauthenticated · `4` access denied ·
  `5` not found · `6` conflict · `8` unavailable · `130` interrupted.
- Writes are never replayed: a timeout or `5xx` on a mutation is reported as
  unavailable and the caller must re-read the page first.
- The token stays inside `ywiki`: read in-process only, never via `argv`, masked
  in all output. Reads are cached on disk (TTL 60 s); a successful write clears
  the cache.

### Documentation

- `README.md` — install, usage, flags, env vars, auth.
- `docs/runbook.md` — operations, troubleshooting, token lifecycle.
- `docs/wiki-api-notes.md` — the confirmed Wiki API surface.
- `docs/conventions.md` — command shape, output modes, exit codes.
- `docs/agent-permissions.md` — OpenCode permission example.
- `AGENTS.md` — the rules that keep the tool dependency-free and token-safe.

[Unreleased]: https://github.com/ishkulov/ywiki/compare/v0.7.3...HEAD
[0.7.3]: https://github.com/ishkulov/ywiki/releases/tag/v0.7.3
[0.7.2]: https://github.com/ishkulov/ywiki/releases/tag/v0.7.2
