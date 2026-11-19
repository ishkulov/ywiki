// ywiki/lib/history.mjs
// Pure helpers for the read-only history commands (`page history`,
// `page revision`). No network and no filesystem here.
//
// `GET /v1/pages/{idx}/revisions` returns revisions newest-first and uses a
// **string** cursor (like comments), not the integer cursor of page lists.

import { UsageError } from "./output.mjs";

/** Documented `page_size` range for the revisions endpoint. */
export const REVISION_PAGE_SIZE_MAX = 50;

/**
 * Validate `--limit` for the revisions endpoint (1–50).
 * @param {number} n
 * @returns {number}
 */
export function validateRevisionPageSize(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > REVISION_PAGE_SIZE_MAX) {
    throw new UsageError(
      `--limit: для истории допустимо 1–${REVISION_PAGE_SIZE_MAX}, получено «${n}»`,
    );
  }
  return n;
}

/**
 * Query string for `GET /v1/pages/{id}/revisions`.
 * @param {{ pageSize?: number, cursor?: string, ids?: string }} [opts]
 */
export function revisionQuery(opts = {}) {
  const parts = [];
  if (opts.pageSize !== undefined) {
    validateRevisionPageSize(opts.pageSize);
    parts.push(`page_size=${opts.pageSize}`);
  }
  if (opts.cursor !== undefined && opts.cursor !== "") {
    parts.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  }
  if (opts.ids !== undefined && opts.ids !== "") {
    parts.push(`ids=${encodeURIComponent(opts.ids)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Comma-separated revision ids, as accepted by the `ids` query parameter. */
export function parseRevisionIds(value) {
  const s = String(value).trim();
  if (!/^\d+(,\d+)*$/.test(s)) {
    throw new UsageError(`--ids: ожидается список целых id через запятую, получено «${value}»`);
  }
  return s;
}

/** Normalise a revision for JSON output. */
export function revisionSummary(r) {
  const draft = r?.revision_draft;
  return {
    id: r?.id ?? null,
    created_at: r?.created_at ?? null,
    author: r?.author?.username ?? null,
    display_name: r?.author?.display_name ?? null,
    page_type: r?.page_type ?? null,
    publication: r?.publication?.status ?? null,
    draft: draft
      ? {
          id: draft.id ?? null,
          created_at: draft.created_at ?? null,
          modified_at: draft.modified_at ?? null,
        }
      : null,
  };
}

/** One-line human label for a revision in the history list. */
export function revisionHead(r, { current = false } = {}) {
  const s = revisionSummary(r);
  const parts = [`#${s.id}`];
  if (s.created_at) parts.push(s.created_at);
  if (s.author) parts.push(s.author);
  if (s.publication) parts.push(`[${s.publication}]`);
  if (s.draft) parts.push("[draft]");
  if (current) parts.push("← current");
  return parts.join(" ");
}

/** Revision metadata for a single page response (`active_revision`). */
export function revisionOf(page) {
  return page?.active_revision ? revisionSummary(page.active_revision) : null;
}

/** Whether a revision id is the page's current `last_revision_id`. */
export function isCurrentRevision(revision, lastRevisionId) {
  if (revision?.id === undefined || revision?.id === null) return false;
  if (lastRevisionId === undefined || lastRevisionId === null) return false;
  return Number(revision.id) === Number(lastRevisionId);
}
