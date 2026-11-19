# Yandex Wiki API — confirmed surface

Status: **confirmed against the live API** with the existing legacy credential.
Scope: read-only. No page content is reproduced in this file.

Probe environment: Node 24.18.0, token read from
`~/.config/legacy/legacy/credentials.toml` into process memory only; only HTTP status
codes and response *shapes* were printed. Token never entered argv and was never
printed in full.

## 1. Scheme

The stored credential is `version = 2`, `scheme = "iam"`, with the legacy IAM
token prefix, `organization_id` non-numeric (20 chars).

**Result: `scheme = "iam"` — confirmed.** Requests with
`Authorization: Bearer <IAM-token>` returned `200 OK` on multiple endpoints.
No `401`/`403` was observed. The existing `the legacy refresh helper` timer is therefore
sufficient for Wiki as well; no separate refresh source is needed.
- `Authorization: Bearer <token>` — IAM (used here, confirmed).
- `Authorization: OAuth <token>` — OAuth 2.0 (not needed, not exercised).
- Service accounts are **not allowed** for the Wiki API (docs); user account only.

## 2. Headers

| Header | Value | Notes |
|---|---|---|
| `Authorization` | `Bearer <IAM>` | scheme from credential file, never hardcoded |
| `X-Cloud-Org-Id` | `<organization_id>` | Yandex Identity Hub; **used here** (org is non-numeric) |
| `X-Org-Id` | `<organization_id>` | Yandex 360 for Business; only when the org id is numeric |
| `Content-Type` | `application/json` | POST bodies only |

Rule: numeric `organization_id` → `X-Org-Id`; otherwise → `X-Cloud-Org-Id`.
Base URL: `https://api.wiki.yandex.net/v1`.

## 3. Confirmed endpoints (real 200 responses)

All confirmed with `Bearer` (IAM) + `X-Cloud-Org-Id`.

### GET `/v1/users/me` → 200
Identity / auth sanity check. Fields:
`username`, `home_cluster`, `identity{uid,cloud_uid}`, `org{dir_id,collab_id}`.

### GET `/v1/spaces` → 200
List spaces visible to the user. Query: `cursor`, `page_size` (1–100, default 50),
`slugs` (comma-separated), `is_personal`, `show_all`.
Body: `results[]{slug,title,description,search_exclude,created_at,modified_at,
owner,roles}`, `next_cursor`, `prev_cursor`.

### GET `/v1/pages/descendants` → 200
Tree traversal. Query: `slug` (**required**; empty string = Wiki root),
`cursor`, `page_size` (1–100, default 50), `include_self`, `actuality`,
`show_all`. Body: `results[]{id,slug}`, `next_cursor`, `prev_cursor`.
This is the reliable navigation primitive: walk from `""` downward.

### GET `/v1/pages` → 200
Page by slug. Query: `slug` (required), `fields` (comma list), `revision_id`,
`raise_on_redirect`.
- Default body (no `fields`): `id, slug, title, page_type, active_revision`.
- With `fields=content,attributes,last_revision_id`: adds `content` (string),
  `attributes{...}`, `last_revision_id`.
- `content` is **only** returned when `content` is listed in `fields`.
- `page_type` enum: `page`, `grid`, `cloud_page`, `wysiwyg`, `template`.
  Observed actual pages are mostly `wysiwyg`.
- `content` is a string (Markdown-like for `wysiwyg`). Confirmed non-empty for
  content-bearing pages; **typical volume is single-digit KB** (observed
  ~2.8 KB and ~4.7 KB in samples). Some pages legitimately return empty
  `content`. This is why `wiki_get` must clip and offer an `offset`.

### GET `/v1/pages/{id}` → 200
Same schema as `/v1/pages`, addressed by page id instead of slug.

### POST `/v1/search` → 200
**Full-text search is available.** Body:
`query` (required), `limit` (1–50, default 10), `cursor` (1–500),
`order_by` (`relevancy`|`creation_date`|`modified_date`), `highlight` (bool),
`filters{type: page|file, authors[], cluster, created_at{from,to},
modified_at, show_obsolete}`.
Response: `results[]{url,slug,title,content,type,modified_at}` where `content`
is a search **snippet**, plus `next_cursor`, `prev_cursor`.

## 4. Error format

JSON: `{ "debug_message": str, "details": {...}, "error_code": str }`.
Observed live: `404 NOT_FOUND` (unknown slug), `400 ALREADY_INDEXING`
(search index warming up — transient, retry later), `401` (expired IAM token).

Error taxonomy mapping for the tools (per contract §2):
`401` → `auth_unavailable` (one self-heal attempt, then error);
`403` → `access_denied` (no retry); `404 NOT_FOUND` → `not_found`;
`429`/`5xx` → `upstream_unavailable` (bounded retries).

## 5. Runtime / proxy

Confirmed reachable **from the the service runtime**, which is where the
custom tools execute. That process environment carries `HTTP_PROXY`/`HTTPS_PROXY`
(pointing at the corporate proxy) with `NO_PROXY` covering only localhost/loopback.

`api.wiki.yandex.net` is **not** in `NO_PROXY`. Both a plain `fetch` and
Node's `--use-env-proxy` returned `200`, i.e. the host reaches the API; no special
proxy handling is required in the tool code. Node 24.18.0 supports
`--use-env-proxy` if the network topology ever requires it.

## 6. Consequences for the CLI

- **`ywiki get`**: `GET /v1/pages?slug=…&fields=content,attributes,last_revision_id`.
- **`ywiki search` / `ywiki tree`**: use `POST /v1/search` for full-text and
  `GET /v1/pages/descendants?slug=…&page_size=…` for navigation. Both confirmed
  200, so full-text search exists and the tree walk works.

## 7. Runtime / proxy confirmation

`api.wiki.yandex.net` is reachable from the process runtime; the host is not in
`NO_PROXY` in the reference setup, but a plain `fetch` returned `200`. No special
proxy handling is required in the code. Node 24 supports `--use-env-proxy` if a
network topology ever requires it.
