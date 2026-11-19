// ywiki/lib/write.mjs
// Pure helpers for the mutating page commands (`page create|edit|append|delete`).
//
// No network and no filesystem here: `bin/ywiki.mjs` wires these helpers to the
// HTTP client and to stdin. Keeping the request shape pure makes the write
// surface testable offline without a stub server.

import { UsageError, WikiError } from "./output.mjs";

/**
 * Encode a slug segment-by-segment, keeping `/` as the path separator.
 * @param {string} q
 * @returns {string}
 */
export function encodeSlug(q) {
  return String(q)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * Read a page by slug with the fields a write needs.
 * @param {{ request: (endpoint: string, init?: any) => Promise<any> }} client
 * @param {string} slug
 * @param {{ fields?: string }} [opts]
 * @returns {Promise<any>}
 */
export async function resolvePage(client, slug, opts = {}) {
  // `page_type` is always returned but is NOT an allowed `fields` value; asking
  // for it makes the API answer 400 BAD_REQUEST.
  const fields = opts.fields ?? "content,attributes,last_revision_id";
  const page = await client.request(
    `/pages?slug=${encodeSlug(slug)}&fields=${encodeURIComponent(fields)}`,
  );
  if (!page || page.id === undefined || page.id === null) {
    throw new WikiError("not_found", `страница «${slug}» не найдена (в ответе нет id)`);
  }
  return page;
}

/**
 * Refuse edits the API cannot honour: read-only pages and content edits on
 * grid / cloud pages. Renaming such pages is still allowed.
 * @param {any} page
 * @param {{ slug: string, content?: string }} opts
 */
export function assertEditable(page, { slug, content }) {
  if (page.attributes?.is_readonly) {
    throw new WikiError("access_denied", `страница «${slug}» доступна только для чтения`);
  }
  if (content !== undefined && (page.page_type === "grid" || page.page_type === "cloud_page")) {
    throw new UsageError(`page edit: страница типа «${page.page_type}» не редактируется через content`);
  }
}

/**
 * Revision to send with a write: the page's `last_revision_id` as a string,
 * or `--if-revision`, or nothing with `--force` (last-write-wins).
 * @param {Record<string, any>} opts
 * @param {any} page
 * @returns {string | undefined}
 */
export function revisionFor(opts, page) {
  const forced = Boolean(opts["--force"]);
  const pinned = opts["--if-revision"];
  if (forced && pinned !== undefined) throw new UsageError("--force и --if-revision взаимоисключающие");
  if (forced) return undefined;
  if (pinned !== undefined) {
    const s = String(pinned).trim();
    if (!s) throw new UsageError("--if-revision: пустое значение");
    return s;
  }
  const id = page.last_revision_id;
  return id === undefined || id === null ? undefined : String(id);
}

/**
 * Compare two contents by common prefix/suffix lines. Enough for a dry-run
 * summary without pulling in a diff dependency.
 * @param {string} before
 * @param {string} after
 * @returns {{ changed: boolean, added: number, removed: number, first_changed_line: number, bytes_before: number, bytes_after: number }}
 */
export function summarizeDiff(before, after) {
  const left = String(before ?? "").replace(/\r\n/g, "\n").split("\n");
  const right = String(after ?? "").replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft--;
    endRight--;
  }
  const removed = endLeft - start;
  const added = endRight - start;
  return {
    changed: removed > 0 || added > 0,
    added,
    removed,
    first_changed_line: start + 1,
    bytes_before: Buffer.byteLength(String(before ?? "")),
    bytes_after: Buffer.byteLength(String(after ?? "")),
  };
}

/**
 * Query string for a write: `fields`, `is_silent`, `allow_merge`.
 * @param {{ fields?: string, silent?: boolean, allowMerge?: boolean }} [opts]
 * @returns {string}
 */
export function writeQuery(opts = {}) {
  const parts = [];
  if (opts.fields) parts.push(`fields=${encodeURIComponent(opts.fields)}`);
  if (opts.silent) parts.push("is_silent=true");
  if (opts.allowMerge) parts.push("allow_merge=true");
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Body for `POST /v1/pages`.
 * @param {{ slug: string, title?: string, content?: string }} input
 */
export function buildCreateBody({ slug, title, content }) {
  if (!slug) throw new UsageError("page create: укажите slug");
  if (typeof title !== "string" || !title.trim()) throw new UsageError("page create: укажите --title");
  const body = { slug, title };
  if (content !== undefined) body.content = content;
  return body;
}

/**
 * Body for `POST /v1/pages/{id}`.
 * @param {{ content?: string, title?: string, revision?: string }} input
 */
export function buildEditBody({ content, title, revision }) {
  if (content === undefined && title === undefined) {
    throw new UsageError("page edit: укажите --file/--stdin/--content или --title");
  }
  if (title !== undefined && !title.trim()) throw new UsageError("--title не может быть пустым");
  const body = {};
  if (content !== undefined) body.content = content;
  if (title !== undefined) body.title = title;
  if (revision !== undefined) body.revision = revision;
  return body;
}

/**
 * Body for `POST /v1/pages/{id}/append-content`: exactly one of
 * `body`, `section`, `anchor`.
 * @param {{
 *   content?: string,
 *   revision?: string,
 *   at?: string,
 *   sectionId?: number,
 *   anchorName?: string,
 *   anchorFallback?: boolean,
 *   anchorRegex?: boolean,
 * }} input
 */
export function buildAppendBody(input) {
  const { content, revision, at, sectionId, anchorName, anchorFallback, anchorRegex } = input;
  if (content === undefined || content === "") {
    throw new UsageError("page append: нужен непустой контент (--file/--stdin/--content)");
  }
  if (sectionId !== undefined && anchorName !== undefined) {
    throw new UsageError("page append: --section и --anchor взаимоисключающие");
  }
  const location = at ?? "bottom";
  if (location !== "top" && location !== "bottom") throw new UsageError("--at: допустимо top|bottom");
  if ((anchorFallback || anchorRegex) && anchorName === undefined) {
    throw new UsageError("--anchor-fallback/--anchor-regex: нужен --anchor");
  }
  /** @type {Record<string, any>} */
  const body = { content };
  if (revision !== undefined) body.revision = revision;
  if (anchorName !== undefined) {
    body.anchor = { name: anchorName, fallback: Boolean(anchorFallback), regex: Boolean(anchorRegex) };
  } else if (sectionId !== undefined) {
    body.section = { id: sectionId, location };
  } else {
    body.body = { location };
  }
  return body;
}
