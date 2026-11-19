#!/usr/bin/env node
// ywiki — read-only CLI for Yandex Wiki, using the existing legacy IAM credential.
//
// Command tree, output modes, error envelope and exit codes mirror `the legacy CLI`
// so agents and scripts can treat both tools the same way. The token is read
// from the credential file by lib/credentials.mjs, never passed via argv, and
// is masked everywhere it could appear in output.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { credentials, credentialPath, redact, AuthError } from "../lib/credentials.mjs";
import { createClient } from "../lib/client.mjs";
import { refreshOnce } from "../lib/refresh.mjs";
import {
  clip,
  clipHint,
  usageText,
  COMMAND_HELP,
  skillText,
  emit,
  wantJson,
  errorEnvelope,
  VERSION,
  EXIT,
  WikiError,
  UsageError,
} from "../lib/output.mjs";
import {
  encodeSlug,
  resolvePage,
  assertEditable,
  revisionFor,
  summarizeDiff,
  writeQuery,
  buildCreateBody,
  buildEditBody,
  buildAppendBody,
} from "../lib/write.mjs";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  "--offset",
  "--limit",
  "--fields",
  "--cursor",
  "--timeout",
  "--timeout-ms",
  "--rich-ui",
  "--file",
  "--content",
  "--title",
  "--if-revision",
  "--at",
  "--section",
  "--anchor",
]);
const BOOL_FLAGS = new Set([
  "--json",
  "--no-cache",
  "--no-input",
  "--all",
  "--help",
  "--version",
  "--stdin",
  "--allow-merge",
  "--force",
  "--silent",
  "--dry-run",
  "--yes",
  "--recursive",
  "--anchor-regex",
  "--anchor-fallback",
]);
/** Short aliases, mirroring the legacy CLI's top-level `-h, --help` / `-v, --version`. */
const SHORT_ALIASES = { "-h": "--help", "-v": "--version" };

/**
 * Parse argv into positionals and a flat options map. `--header` is repeatable
 * and collected into an array.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string | boolean | string[]>} */
  const opts = {};

  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    // Support the `--flag=value` form (e.g. `--rich-ui=yes`) as the legacy CLI does.
    let inline;
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
      if (inline === "") throw new UsageError(`флагу ${a} нужно значение`);
    }
    if (a in SHORT_ALIASES) a = SHORT_ALIASES[a];
    if (a === "--header") {
      const v = inline !== undefined ? inline : argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError("флагу --header нужно значение");
      const arr = Array.isArray(opts["--header"]) ? opts["--header"] : [];
      arr.push(v);
      opts["--header"] = arr;
      if (inline === undefined) i++;
    } else if (VALUE_FLAGS.has(a)) {
      const v = inline !== undefined ? inline : argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`флагу ${a} нужно значение`);
      opts[a] = v;
      if (inline === undefined) i++;
    } else if (BOOL_FLAGS.has(a)) {
      if (inline !== undefined) throw new UsageError(`флаг ${a} не принимает значение`);
      opts[a] = true;
    } else if (a.startsWith("--")) {
      throw new UsageError(`неизвестный флаг: ${a}`);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, opts };
}

/** @param {Record<string, any>} opts @param {string} name @param {number|undefined} def */
function intOpt(opts, name, def) {
  if (!(name in opts)) return def;
  const n = Number(opts[name]);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new UsageError(`флаг ${name}: нужно целое ≥ 0`);
  return n;
}

// ---------------------------------------------------------------------------
// Command resolution (groups + flat shortcuts)
// ---------------------------------------------------------------------------

/**
 * Map parsed positionals to a canonical command path and its arguments.
 * @param {string[]} positionals
 * @returns {{ key: string, handler: string, args: string[] }}
 */
function resolveCommand(positionals) {
  const [cmd, ...rest] = positionals;
  switch (cmd) {
    case "whoami":
      return { key: "whoami", handler: "whoami", args: rest };
    case "page": {
      const verb = rest[0];
      const args = rest.slice(1);
      if (verb === "get") return { key: "page get", handler: "get", args };
      if (verb === "search") return { key: "page search", handler: "search", args };
      if (verb === "descendants") return { key: "page descendants", handler: "descendants", args };
      if (verb === "comments") return { key: "page comments", handler: "comments", args };
      if (verb === "create") return { key: "page create", handler: "create", args };
      if (verb === "edit") return { key: "page edit", handler: "edit", args };
      if (verb === "append") return { key: "page append", handler: "append", args };
      if (verb === "delete") return { key: "page delete", handler: "delete", args };
      throw new UsageError(
        `page: неизвестная подкоманда «${verb ?? ""}» (get|search|descendants|comments|create|edit|append|delete)`,
      );
    }
    case "space": {
      const verb = rest[0];
      if (verb !== "list") throw new UsageError(`space: неизвестная подкоманда «${verb ?? ""}» (list)`);
      return { key: "space list", handler: "spaces", args: rest.slice(1) };
    }
    case "get":
      return { key: "get", handler: "get", args: rest };
    case "search":
      return { key: "search", handler: "search", args: rest };
    case "tree":
      return { key: "tree", handler: "descendants", args: rest };
    case "spaces":
      return { key: "spaces", handler: "spaces", args: rest };
    case "api":
      return { key: "api", handler: "api", args: rest };
    case "skill":
      return { key: "skill", handler: "skill", args: rest };
    default:
      throw new UsageError(`неизвестная команда: ${cmd ?? ""}`);
  }
}

// ---------------------------------------------------------------------------
// Client + pagination helpers
// ---------------------------------------------------------------------------

function timeoutFrom(opts) {
  if ("--timeout-ms" in opts) return intOpt(opts, "--timeout-ms", undefined);
  const seconds = intOpt(opts, "--timeout", undefined);
  return seconds === undefined ? undefined : seconds * 1000;
}

function makeClient(opts) {
  return createClient({
    noCache: Boolean(opts["--no-cache"]),
    timeoutMs: timeoutFrom(opts),
    refresh: () => refreshOnce({}),
  });
}

/**
 * Client for a write: the disk cache is bypassed so the content and revision we
 * base the change on are fresh. The client clears the cache after a write.
 */
function makeWriteClient(opts) {
  return createClient({
    noCache: true,
    timeoutMs: timeoutFrom(opts),
    refresh: () => refreshOnce({}),
  });
}

const CONTENT_FLAGS = ["--file", "--content", "--stdin"];

/** @param {string} label */
async function readStdin(label) {
  if (process.stdin.isTTY) throw new UsageError(`${label}: --stdin требует перенаправленный поток`);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve the single content source: `--file`, `--stdin` or `--content`.
 * `--content ""` is meaningful (it clears the page), so presence is tested
 * with `in` rather than by truthiness.
 * @param {Record<string, any>} opts
 * @param {{ required?: boolean, label?: string }} [cfg]
 * @returns {Promise<string | undefined>}
 */
async function contentFrom(opts, cfg = {}) {
  const { required = false, label = "команда" } = cfg;
  const used = CONTENT_FLAGS.filter((f) => f in opts);
  if (used.length > 1) {
    throw new UsageError(`${label}: укажите ровно один источник — --file, --stdin или --content`);
  }
  if (!used.length) {
    if (required) throw new UsageError(`${label}: нужен контент — --file, --stdin или --content`);
    return undefined;
  }
  if ("--file" in opts) {
    try {
      return readFileSync(String(opts["--file"]), "utf8");
    } catch (e) {
      throw new UsageError(
        `${label}: не удалось прочитать --file «${opts["--file"]}»: ${redact((e && e.code) || (e && e.message) || e)}`,
      );
    }
  }
  if ("--content" in opts) return String(opts["--content"]);
  return readStdin(label);
}

/** @param {string} question @returns {Promise<boolean>} */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes" || answer === "да";
  } finally {
    rl.close();
  }
}

/** Print helper: JSON payload or rendered human text (TTY-aware). */
function out(opts, payload, human) {
  emit(payload, human, { json: Boolean(opts["--json"]), richUi: opts["--rich-ui"] });
}

function line(s = "") {
  process.stdout.write(s + "\n");
}

/**
 * Follow `next_cursor` until exhausted (or the page budget is hit), collecting
 * `results`. Only used when `--all` is set.
 * @param {(cursor: number | undefined) => Promise<any>} fetchPage
 * @param {number} [maxPages]
 */
async function collectAll(fetchPage, maxPages = 100) {
  /** @type {any[]} */
  const results = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    if (Array.isArray(page.results)) results.push(...page.results);
    if (!page.next_cursor) return { results, nextCursor: null };
    cursor = page.next_cursor;
  }
  return { results, nextCursor: cursor ?? null };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdWhoami(opts) {
  const client = makeClient(opts);
  const c = credentials();
  const me = await client.request("/users/me");
  const path = credentialPath();
  const ageMs = c.mtimeMs ? Date.now() - c.mtimeMs : null;
  const ageH = ageMs === null ? "н/д (ENV)" : `${(ageMs / 3600000).toFixed(1)} ч`;
  const tok = c.token.length <= 6 ? c.token : c.token.slice(0, 6) + "…";
  const numericOrg = /^\d+$/.test(String(c.org));
  const payload = {
    identity: { login: me.username, display: me.display_name ?? null },
    contour: c.org === "" ? null : "legacy",
    credentialSource: c.mtimeMs ? "file" : "env",
    scheme: c.scheme,
    organizationId: c.org,
    organizationKind: numericOrg ? "360" : "cloud",
    credential: path,
    credentialAgeHours: ageMs === null ? null : Number((ageMs / 3600000).toFixed(1)),
    token: tok,
  };
  // Rich form mirrors the legacy CLI's `✓ Authenticated as …` block.
  const human = (p) => [
    `✓ Authenticated as ${p.identity.login}`,
    `  Contour: ${p.contour ?? "legacy"}`,
    `  Credential source: ${p.credentialSource}`,
    `  Credential scheme: ${p.scheme}`,
    `  Organization: ${p.organizationId} (${p.organizationKind})`,
    `  Credential file: ${p.credential}`,
    `  Age: ${ageH}`,
    `  Token: ${p.token}`,
  ].join("\n");
  out(opts, payload, human);
}

async function cmdGet(opts, slug) {
  if (!slug) throw new UsageError("get: укажите slug");
  const offset = intOpt(opts, "--offset", 0);
  const limit = intOpt(opts, "--limit", undefined);
  const fields = typeof opts["--fields"] === "string" ? opts["--fields"] : "content,attributes,last_revision_id";
  const client = makeClient(opts);
  const page = await client.request(`/pages?slug=${encodeSlug(slug)}&fields=${encodeURIComponent(fields)}`);
  const content = typeof page.content === "string" ? page.content : "";
  const c = clip(content, offset, limit);
  const payload = {
    slug: page.slug,
    title: page.title,
    modified_at: page.attributes?.modified_at ?? null,
    content: c.text,
    truncated: c.truncated,
    next_offset: c.truncated ? c.nextOffset : null,
  };
  const human = () => {
    const lines = [`# ${page.title}`, `slug: ${page.slug}`];
    if (page.attributes?.modified_at) lines.push(`modified: ${page.attributes.modified_at}`);
    lines.push("");
    if (!content.trim()) {
      lines.push("EMPTY: страница существует, содержимого нет");
      return lines.join("\n");
    }
    lines.push(c.text);
    const hint = clipHint(c);
    if (hint) lines.push("", hint);
    return lines.join("\n");
  };
  out(opts, payload, human);
}

async function cmdSearch(opts, query) {
  if (!query) throw new UsageError("search: укажите запрос");
  const client = makeClient(opts);
  const limit = intOpt(opts, "--limit", undefined);
  const cursor = intOpt(opts, "--cursor", undefined);
  const bodyFor = (cur) => ({
    query,
    ...(limit === undefined ? {} : { limit }),
    ...(cur === undefined ? {} : { cursor: cur }),
    filters: { type: "page" },
  });
  const fetchPage = (cur) => client.request("/search", { method: "POST", body: bodyFor(cur) });

  let results;
  let nextCursor = null;
  if (opts["--all"]) {
    ({ results, nextCursor } = await collectAll(fetchPage));
  } else {
    const res = await fetchPage(cursor);
    results = Array.isArray(res.results) ? res.results : [];
    nextCursor = res.next_cursor ?? null;
  }

  const payload = {
    query,
    results: results.map((r) => ({ slug: r.slug, title: r.title })),
    next_cursor: nextCursor,
  };
  const human = () => {
    if (!results.length) {
      return `Ничего не найдено по запросу «${query}».\nПодсказка: проверьте формулировку, попробуйте другой термин.`;
    }
    return results.map((r) => `${r.slug} — ${r.title}`).join("\n");
  };
  out(opts, payload, human);
}

async function cmdDescendants(opts, slug) {
  const client = makeClient(opts);
  const pageSize = intOpt(opts, "--limit", undefined);
  const cursor = intOpt(opts, "--cursor", undefined);
  const queryOf = (cur) =>
    `/pages/descendants?slug=${encodeSlug(slug ?? "")}` +
    (pageSize === undefined ? "" : `&page_size=${pageSize}`) +
    (cur === undefined ? "" : `&cursor=${cur}`);
  const fetchPage = (cur) => client.request(queryOf(cur));

  let results;
  let nextCursor = null;
  if (opts["--all"]) {
    ({ results, nextCursor } = await collectAll(fetchPage));
  } else {
    const res = await fetchPage(cursor);
    results = Array.isArray(res.results) ? res.results : [];
    nextCursor = res.next_cursor ?? null;
  }

  const payload = { slug: slug ?? "", results, next_cursor: nextCursor };
  const human = () => {
    if (!results.length) {
      return `Подстраниц нет (или нет доступа) для «${slug ?? ""}».\nПодсказка: проверьте slug или используйте \`ywiki search\`.`;
    }
    return results.map((r) => r.slug).join("\n");
  };
  out(opts, payload, human);
}

async function cmdComments(opts, slug) {
  if (!slug) throw new UsageError("page comments: укажите slug");
  const client = makeClient(opts);
  const pageSize = intOpt(opts, "--limit", undefined);
  const meta = await client.request(`/pages?slug=${encodeSlug(slug)}`);
  const id = meta.id;
  if (id === undefined || id === null) throw new WikiError("not_found", `страница «${slug}» без id`);
  const queryOf = (cur) =>
    `/pages/${encodeURIComponent(String(id))}/comments` +
    (pageSize === undefined ? "" : `?page_size=${pageSize}`) +
    (cur === undefined ? "" : `${pageSize === undefined ? "?" : "&"}cursor=${encodeURIComponent(cur)}`);
  const fetchPage = (cur) => client.request(queryOf(cur));

  let results;
  let nextCursor = null;
  if (opts["--all"]) {
    ({ results, nextCursor } = await collectAll(fetchPage));
  } else {
    const res = await fetchPage(undefined);
    results = Array.isArray(res.results) ? res.results : [];
    nextCursor = res.next_cursor ?? null;
  }

  const payload = {
    slug,
    id,
    results: results.map((c) => ({
      id: c.id,
      body: c.body,
      author: c.author?.username ?? null,
      created_at: c.created_at ?? null,
      resolve_status: c.resolve_status ?? null,
      reply_count: c.thread_info?.total_posts ?? 0,
    })),
    next_cursor: nextCursor,
  };
  const human = () => {
    if (!results.length) {
      return `Комментариев нет для «${slug}».\nПодсказка: проверьте slug или используйте \`ywiki search\`.`;
    }
    return results
      .map((c) => {
        const n = c.thread_info?.total_posts ?? 0;
        const head = `#${c.id} ${c.author?.username ?? "?"} ${c.created_at ?? ""} [${c.resolve_status ?? "?"}]${n ? ` (+${n} ответов)` : ""}`;
        return `${head}\n${c.body ?? ""}`;
      })
      .join("\n\n");
  };
  out(opts, payload, human);
}

async function cmdSpaces(opts) {
  const client = makeClient(opts);
  const fetchPage = (cur) => client.request("/spaces" + (cur === undefined ? "" : `?cursor=${cur}`));

  let results;
  let nextCursor = null;
  if (opts["--all"]) {
    ({ results, nextCursor } = await collectAll(fetchPage));
  } else {
    const res = await fetchPage(undefined);
    results = Array.isArray(res.results) ? res.results : [];
    nextCursor = res.next_cursor ?? null;
  }

  const payload = { results: results.map((s) => ({ slug: s.slug, title: s.title })), next_cursor: nextCursor };
  const human = () =>
    results.length ? results.map((s) => `${s.slug} — ${s.title}`).join("\n") : "Пространств не найдено.";
  out(opts, payload, human);
}

async function cmdCreate(opts, slug) {
  const content = await contentFrom(opts, { label: "page create" });
  const body = buildCreateBody({ slug, title: opts["--title"], content });
  const contentBytes = content === undefined ? 0 : Buffer.byteLength(content);
  if (opts["--dry-run"]) {
    const payload = {
      dry_run: true,
      action: "create",
      slug: body.slug,
      title: body.title,
      content_bytes: contentBytes,
      silent: Boolean(opts["--silent"]),
    };
    out(opts, payload, (p) => `dry-run: создать «${p.slug}» — «${p.title}», ${p.content_bytes} байт`);
    return;
  }
  const client = makeWriteClient(opts);
  const page = await client.request(
    "/pages" + writeQuery({ fields: "last_revision_id,attributes", silent: Boolean(opts["--silent"]) }),
    { method: "POST", body },
  );
  const payload = {
    id: page.id ?? null,
    slug: page.slug ?? body.slug,
    title: page.title ?? body.title,
    last_revision_id: page.last_revision_id ?? null,
    modified_at: page.attributes?.modified_at ?? null,
  };
  out(opts, payload, (p) => [
    `✓ Создана страница ${p.slug} (id ${p.id ?? "?"}, ревизия ${p.last_revision_id ?? "н/д"})`,
    `  ссылка: ywiki page get ${p.slug}`,
  ].join("\n"));
}

async function cmdEdit(opts, slug) {
  if (!slug) throw new UsageError("page edit: укажите slug");
  if (!("--title" in opts) && !CONTENT_FLAGS.some((f) => f in opts)) {
    throw new UsageError("page edit: укажите --file/--stdin/--content или --title");
  }
  const content = await contentFrom(opts, { label: "page edit" });
  const client = makeWriteClient(opts);
  const page = await resolvePage(client, slug);
  assertEditable(page, { slug, content });
  const revision = revisionFor(opts, page);
  const body = buildEditBody({ content, title: opts["--title"], revision });
  const before = typeof page.content === "string" ? page.content : "";
  const diff = content === undefined ? null : summarizeDiff(before, content);

  if (opts["--dry-run"]) {
    const payload = {
      dry_run: true,
      action: "edit",
      slug,
      id: page.id,
      title: body.title ?? page.title ?? null,
      revision: revision ?? null,
      changed: diff ? diff.changed : null,
      added: diff ? diff.added : null,
      removed: diff ? diff.removed : null,
      first_changed_line: diff ? diff.first_changed_line : null,
      bytes_before: diff ? diff.bytes_before : null,
      bytes_after: diff ? diff.bytes_after : null,
    };
    out(opts, payload, (p) => {
      const head = `dry-run: изменить ${p.slug} (id ${p.id}, revision ${p.revision ?? "не отправляется"})`;
      if (!diff) return `${head}\n  будет изменён только заголовок → «${p.title}»`;
      return `${head}\n  строк: +${diff.added}/-${diff.removed} с ${diff.first_changed_line}; байт: ${diff.bytes_before} → ${diff.bytes_after}`;
    });
    return;
  }

  const res = await client.request(
    `/pages/${encodeURIComponent(String(page.id))}` +
      writeQuery({
        fields: "last_revision_id,attributes",
        silent: Boolean(opts["--silent"]),
        allowMerge: Boolean(opts["--allow-merge"]),
      }),
    { method: "POST", body },
  );
  const payload = {
    id: res.id ?? page.id,
    slug: res.slug ?? slug,
    title: res.title ?? body.title ?? page.title ?? null,
    revision_before: revision ?? null,
    last_revision_id: res.last_revision_id ?? null,
    modified_at: res.attributes?.modified_at ?? null,
    changed: diff ? diff.changed : null,
    bytes_before: diff ? diff.bytes_before : null,
    bytes_after: diff ? diff.bytes_after : null,
  };
  out(opts, payload, (p) => {
    const head = `✓ Обновлено: ${p.slug} (id ${p.id}, ревизия ${p.last_revision_id ?? "н/д"})`;
    if (!diff) return `${head}\n  заголовок → «${p.title}»`;
    return `${head}\n  строк: +${diff.added}/-${diff.removed}; байт: ${diff.bytes_before} → ${diff.bytes_after}`;
  });
}

async function cmdAppend(opts, slug) {
  if (!slug) throw new UsageError("page append: укажите slug");
  const content = await contentFrom(opts, { required: true, label: "page append" });
  const sectionId = "--section" in opts ? intOpt(opts, "--section", undefined) : undefined;
  const client = makeWriteClient(opts);
  const page = await resolvePage(client, slug, { fields: "attributes,last_revision_id" });
  assertEditable(page, { slug, content });
  const revision = revisionFor(opts, page);
  const body = buildAppendBody({
    content,
    revision,
    at: typeof opts["--at"] === "string" ? opts["--at"] : undefined,
    sectionId,
    anchorName: typeof opts["--anchor"] === "string" ? opts["--anchor"] : undefined,
    anchorFallback: Boolean(opts["--anchor-fallback"]),
    anchorRegex: Boolean(opts["--anchor-regex"]),
  });
  const addedBytes = Buffer.byteLength(String(content));

  if (opts["--dry-run"]) {
    const payload = {
      dry_run: true,
      action: "append",
      slug,
      id: page.id,
      revision: revision ?? null,
      body: body.body ?? null,
      section: body.section ?? null,
      anchor: body.anchor ?? null,
      added_bytes: addedBytes,
    };
    out(opts, payload, (p) => {
      const place = p.anchor
        ? `после якоря «${p.anchor.name}»`
        : p.section
          ? `в раздел ${p.section.id} (${p.section.location})`
          : `${p.body?.location === "top" ? "в начало" : "в конец"}`;
      return `dry-run: дописать ${p.slug} ${place}, ${p.added_bytes} байт (revision ${p.revision ?? "не отправляется"})`;
    });
    return;
  }

  const res = await client.request(
    `/pages/${encodeURIComponent(String(page.id))}/append-content` +
      writeQuery({ fields: "last_revision_id,attributes", silent: Boolean(opts["--silent"]) }),
    { method: "POST", body },
  );
  const payload = {
    id: res.id ?? page.id,
    slug: res.slug ?? slug,
    title: res.title ?? page.title ?? null,
    revision_before: revision ?? null,
    last_revision_id: res.last_revision_id ?? null,
    modified_at: res.attributes?.modified_at ?? null,
    added_bytes: addedBytes,
  };
  out(opts, payload, (p) => `✓ Дописано в ${p.slug} (id ${p.id}, ревизия ${p.last_revision_id ?? "н/д"}, +${p.added_bytes} байт)`);
}

async function cmdDelete(opts, slug) {
  if (!slug) throw new UsageError("page delete: укажите slug");
  const client = makeWriteClient(opts);
  const page = await resolvePage(client, slug, { fields: "attributes,last_revision_id" });
  const recursive = Boolean(opts["--recursive"]);

  if (opts["--dry-run"]) {
    const payload = { dry_run: true, action: "delete", slug, id: page.id, title: page.title ?? null, recursive };
    out(opts, payload, (p) => `dry-run: удалить «${p.slug}» (id ${p.id})${p.recursive ? " со всеми подстраницами" : ""}`);
    return;
  }

  if (!opts["--yes"]) {
    if (opts["--no-input"] || !process.stdin.isTTY) {
      throw new UsageError("page delete: нужно явное подтверждение — используйте --yes (или --dry-run)");
    }
    const ok = await confirm(
      `Удалить «${slug}»${page.title ? ` (${page.title})` : ""}${recursive ? " со всеми подстраницами" : ""}? [y/N] `,
    );
    if (!ok) throw new UsageError("page delete: отменено");
  }

  const res = await client.request(
    `/pages/${encodeURIComponent(String(page.id))}` + (recursive ? "?recursive=true" : ""),
    { method: "DELETE" },
  );
  const payload = {
    id: page.id,
    slug,
    title: page.title ?? null,
    recovery_token: res?.recovery_token ?? null,
  };
  out(opts, payload, (p) => [
    `✓ Удалена страница ${p.slug} (id ${p.id})`,
    `  recovery_token: ${p.recovery_token ?? "н/д"}`,
    "  восстановление: POST /v1/recovery_tokens/<token>/recover",
  ].join("\n"));
}

/** Read-only passthrough restricted to the confirmed API surface. */
const API_ALLOWED = ["pages", "spaces", "users/me", "search"];

async function cmdApi(opts, args) {
  const method = (args[0] || "").toUpperCase();
  const path = args[1];
  if (!method || !path) throw new UsageError("api: использование — ywiki api GET <path>");
  if (method !== "GET") throw new UsageError("api: read-only — допустим только метод GET");
  const bare = path.replace(/^\/+/, "");
  if (!API_ALLOWED.some((p) => bare === p || bare.startsWith(p + "/") || bare.startsWith(p + "?"))) {
    throw new UsageError(`api: путь вне подтверждённой поверхности (${API_ALLOWED.join(", ")})`);
  }
  /** @type {Record<string,string>} */
  const headers = {};
  for (const h of Array.isArray(opts["--header"]) ? opts["--header"] : []) {
    const idx = h.indexOf(":");
    if (idx <= 0) throw new UsageError(`--header: ожидается "Name: value", получено «${h}»`);
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  const client = makeClient(opts);
  const res = await client.request("/" + bare, { headers });
  out(opts, res, (v) => JSON.stringify(v, null, 2));
}

function cmdSkill() {
  line(skillText());
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(errorEnvelope("usage", e.message) + usageText() + "\n");
      process.exit(EXIT.usage);
    }
    throw e;
  }
  const { positionals, opts } = parsed;

  if (opts["--version"]) {
    if (opts["--json"]) {
      process.stdout.write(JSON.stringify({ version: VERSION, contour: "legacy" }) + "\n");
    } else {
      line(`ywiki ${VERSION}`);
    }
    return;
  }

  if (positionals.length === 0) {
    line(usageText());
    process.exit(opts["--help"] ? EXIT.ok : EXIT.usage);
  }

  let resolved;
  try {
    resolved = resolveCommand(positionals);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(errorEnvelope("usage", e.message) + usageText() + "\n");
      process.exit(EXIT.usage);
    }
    throw e;
  }

  if (opts["--help"]) {
    line(COMMAND_HELP[resolved.key] || usageText());
    return;
  }

  switch (resolved.handler) {
    case "whoami":
      await cmdWhoami(opts);
      break;
    case "get":
      await cmdGet(opts, resolved.args[0]);
      break;
    case "search":
      await cmdSearch(opts, resolved.args.join(" "));
      break;
    case "descendants":
      await cmdDescendants(opts, resolved.args[0]);
      break;
    case "comments":
      await cmdComments(opts, resolved.args[0]);
      break;
    case "create":
      await cmdCreate(opts, resolved.args[0]);
      break;
    case "edit":
      await cmdEdit(opts, resolved.args[0]);
      break;
    case "append":
      await cmdAppend(opts, resolved.args[0]);
      break;
    case "delete":
      await cmdDelete(opts, resolved.args[0]);
      break;
    case "spaces":
      await cmdSpaces(opts);
      break;
    case "api":
      await cmdApi(opts, resolved.args);
      break;
    case "skill":
      cmdSkill();
      break;
    default:
      throw new UsageError(`неизвестная команда: ${resolved.handler}`);
  }
}

main().catch((e) => {
  if (e instanceof UsageError) {
    process.stderr.write(errorEnvelope("usage", e.message) + usageText() + "\n");
    process.exit(EXIT.usage);
  }
  if (e instanceof AuthError) {
    process.stderr.write(errorEnvelope(e.kind, redact(e.message)));
    process.exit(EXIT[e.kind] ?? EXIT.unavailable);
  }
  const kind = e && e.kind;
  if (kind && kind in EXIT) {
    process.stderr.write(errorEnvelope(kind, redact((e && e.message) || e)));
    process.exit(EXIT[kind]);
  }
  process.stderr.write(errorEnvelope("unavailable", redact((e && e.message) || e)));
  process.exit(EXIT.unavailable);
});
