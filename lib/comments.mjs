// ywiki/lib/comments.mjs
// Pure helpers for the comment commands (`page comment list|add|reply|delete`).
// No network and no filesystem here.

import { UsageError } from "./output.mjs";

/** Positive integer id from a positional argument. */
export function parseId(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new UsageError(`${label}: нужен положительный целый id, получено «${value ?? ""}»`);
  }
  return n;
}

/**
 * Body for `POST /v1/pages/{id}/comments`.
 * @param {{ body: string, inlineText?: string, parentId?: number, threadId?: number }} input
 */
export function buildCommentBody({ body, inlineText, parentId, threadId }) {
  if (typeof body !== "string" || !body.trim()) {
    throw new UsageError("комментарий: нужен непустой текст");
  }
  const out = { body };
  if (inlineText !== undefined) out.inline_text = inlineText;
  if (parentId !== undefined) out.parent_id = parentId;
  if (threadId !== undefined) out.thread_id = threadId;
  return out;
}

/**
 * Query string for the comment list. `cursor` is a string, unlike page cursors.
 * @param {{ pageSize?: number, cursor?: string, status?: string, order?: string }} [opts]
 */
export function commentQuery(opts = {}) {
  const parts = [];
  if (opts.pageSize !== undefined) parts.push(`page_size=${opts.pageSize}`);
  if (opts.cursor !== undefined && opts.cursor !== "") {
    parts.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  }
  if (opts.status) parts.push(`status_filter=${encodeURIComponent(opts.status)}`);
  if (opts.order) {
    parts.push("order_by=created_at");
    parts.push(`order_direction=${encodeURIComponent(opts.order)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Query string for a thread. Status filtering is not documented for threads.
 * @param {{ pageSize?: number, cursor?: string, order?: string }} [opts]
 */
export function threadQuery(opts = {}) {
  const parts = [];
  if (opts.pageSize !== undefined) parts.push(`page_size=${opts.pageSize}`);
  if (opts.cursor !== undefined && opts.cursor !== "") {
    parts.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  }
  if (opts.order) {
    parts.push("order_by=created_at");
    parts.push(`order_direction=${encodeURIComponent(opts.order)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Normalise a comment for JSON output. */
export function commentSummary(c) {
  return {
    id: c.id ?? null,
    body: c.body ?? null,
    inline_text: c.inline_text ?? null,
    parent_id: c.parent_id ?? null,
    thread_id: c.thread_id ?? c.id ?? null,
    author: c.author?.username ?? null,
    created_at: c.created_at ?? null,
    resolve_status: c.resolve_status ?? null,
    reply_count: c.thread_info?.total_posts ?? 0,
    is_deleted: Boolean(c.is_deleted),
  };
}

/** One-line human label for a comment. */
export function commentHead(c) {
  const n = c.thread_info?.total_posts ?? 0;
  const anchor = c.inline_text ? ` «${c.inline_text}»` : "";
  const status = c.resolve_status ? ` [${c.resolve_status}]` : "";
  const replies = n ? ` (+${n} ответов)` : "";
  return `#${c.id} ${c.author?.username ?? "?"} ${c.created_at ?? ""}${status}${anchor}${replies}`;
}
