# Yandex Wiki API — surface notes

Status: **read endpoints confirmed against the live API** with the existing legacy
credential; **write endpoints are documented but NOT live-confirmed** (see §4).
No page content is reproduced in this file.

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

### GET `/v1/pages/{id}/comments` → 200
List top-level discussion comments for a page. Keyed by the **numeric page id**
(equal to the `id` field returned by `GET /v1/pages?slug=…`), **not** the slug.
Replies inside threads are excluded; use
`GET /v1/pages/{id}/comments/{comment_id}/thread` for those. Default sort:
newest first by creation date. Query: `cursor` (**string**; from
`next_cursor`/`prev_cursor`), `page_size` (1–100, default 50),
`order_by` (`created_at`), `order_direction` (`asc`|`desc`), `status_filter`
(`resolved`|`unresolved`). Body: `results[]` of `CommentSchemaExt`
(`id`, `body`, `inline_text`, `parent_id`, `author{id,username,display_name,…}`,
`thread_id`, `created_at`, `is_deleted`, `resolve_status`, `reactions[]`,
`thread_info{total_posts,last_comment}`), plus `next_cursor`, `prev_cursor`.
Note: the comments cursor is a **string**, unlike the integer cursors elsewhere.

### POST `/v1/search` → 200
**Full-text search is available.** Body:
`query` (required), `limit` (1–50, default 10), `cursor` (1–500),
`order_by` (`relevancy`|`creation_date`|`modified_date`), `highlight` (bool),
`filters{type: page|file, authors[], cluster, created_at{from,to},
modified_at, show_obsolete}`.
Response: `results[]{url,slug,title,content,type,modified_at}` where `content`
is a search **snippet**, plus `next_cursor`, `prev_cursor`.

## 4. Write surface (documented, **not** live-confirmed)

Taken from the official API reference
(`yandex.ru/support/wiki/ru/api-ref/pages/…`) during the write feature work.
None of these calls has been exercised against the live API yet: the shape below
is what `ywiki page create|edit|append|delete` sends, so a first real use is the
confirmation. Unverified points are marked **?**.

Write requests are user-scoped: the IAM token works only if the signed-in user
may edit the page; otherwise expect `403`. There is no `wiki:write` scope to
grant for an IAM token (that is OAuth terminology).

### POST `/v1/pages` — create

Query: `fields`, `is_silent` (bool, default false).
Body: `slug` (**required**), `title` (**required**, 1–255),
`content` (optional), `access_policy` (optional).
Response: page schema (same as `GET /v1/pages`).

### POST `/v1/pages/{idx}` — update (POST, not PUT/PATCH)

Query: `allow_merge` (bool, default **false** — concurrent edits are a conflict;
`true` = 3-way merge), `is_silent`, `fields`.
Body: `title`, `content`, `revision`, `redirect`, `access_policy`, `owner`,
`actuality` (all optional).
`revision` is documented as “the page version this change is based on” and is a
**string** in the schema, while `last_revision_id` is an **integer**. `ywiki`
sends `String(last_revision_id)`; **?** this equivalence is unverified. The
status code for a revision mismatch is also **?** (docs say “conflict”; the
client maps both `409` and `400` to `conflict`).
Response: page schema; `content` only when requested via `fields=content`.

### POST `/v1/pages/{idx}/append-content` — append

Query: `fields`, `is_silent`.
Body: `content` (**required**, min length 1), `revision` (string), and exactly
**one** of:
- `body: {location: "top"|"bottom"}` — insert at the start/end of the page;
- `section: {id, location}` — insert into a page section;
- `anchor: {name, fallback, regex}` — insert after an anchor; `fallback=true`
  appends to the end when the anchor is missing.
Response: page schema.

### DELETE `/v1/pages/{idx}` — delete

Query: `recursive` (bool, default false — delete sub-pages too).
Response: `{recovery_token}`; restore with
`POST /v1/recovery_tokens/{recovery_token}/recover` (**?** not implemented in
`ywiki` yet).

### Safety notes

- A cheap permission probe (documented by third-party clients) is
  `POST /v1/pages/{id}` with body `{}`: `400 VALIDATION_ERROR` means write access
  is present, `403` means it is not. Not used by `ywiki`.
- Collaborative pages (`attributes.is_collaborative`) may produce a draft
  revision instead of publishing; **?** unverified.
- `ywiki --force` omits `revision` (last-write-wins) as an escape hatch while
  the `revision` semantics remain unconfirmed.

## 5. Error format

JSON: `{ "debug_message": str, "details": {...}, "error_code": str }`.
Observed live: `404 NOT_FOUND` (unknown slug), `400 ALREADY_INDEXING`
(search index warming up — transient, retry later), `401` (expired IAM token).

Error taxonomy mapping for the CLI (aligned with `the legacy CLI`, see docs/compat.md):
`401` → `unauthenticated` (exit 3; one self-heal attempt, then error);
`403` → `access_denied` (exit 4, no retry); `404 NOT_FOUND` → `not_found` (exit 5);
`409` / `400 ALREADY_INDEXING` → `conflict` (exit 6);
`429`/`5xx`/network → `unavailable` (exit 8, bounded retries).

## 6. Runtime / proxy

Confirmed reachable **from the the service runtime**, which is where the
custom tools execute. That process environment carries `HTTP_PROXY`/`HTTPS_PROXY`
(pointing at the corporate proxy) with `NO_PROXY` covering only localhost/loopback.

`api.wiki.yandex.net` is **not** in `NO_PROXY`. Both a plain `fetch` and
Node's `--use-env-proxy` returned `200`, i.e. the host reaches the API; no special
proxy handling is required in the tool code. Node 24.18.0 supports
`--use-env-proxy` if the network topology ever requires it.

## 7. Consequences for the CLI

- **`ywiki get`**: `GET /v1/pages?slug=…&fields=content,attributes,last_revision_id`.
- **`ywiki search`**: `POST /v1/search` for full-text search.
- **`ywiki tree`**: `GET /v1/pages/descendants?slug=…&page_size=…` for navigation.
  Both confirmed 200, so full-text search exists and the tree walk works.
- **`ywiki page comments`**: resolve the id via `GET /v1/pages?slug=…`, then
  `GET /v1/pages/{id}/comments?page_size=…` for top-level comments.
- **`ywiki page create`**: `POST /v1/pages` with `{slug, title, content?}`.
- **`ywiki page edit`**: `GET` the page with
  `fields=content,attributes,last_revision_id,page_type`, then
  `POST /v1/pages/{id}` with `{content?, title?, revision?}`; `allow_merge` is
  off by default and `--force` omits `revision`.
- **`ywiki page append`**: `POST /v1/pages/{id}/append-content` with
  `{content, revision?, body|section|anchor}`.
- **`ywiki page delete`**: `DELETE /v1/pages/{id}?recursive=` → `recovery_token`.
