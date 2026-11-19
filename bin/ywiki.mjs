#!/usr/bin/env node
// ywiki — CLI for Yandex Wiki with its own credential and auth flow.
//
// Command tree, output modes, error envelope and exit codes are described in
// README.md. The token is read
// from ~/.config/ywiki/credentials.toml (or WIKI_* env), never passed via argv,
// and is masked everywhere it could appear in output.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { credentials, credentialPath, hasEnvCredential, redact, AuthError } from "../lib/credentials.mjs";
import { createClient } from "../lib/client.mjs";
import { refreshOnce } from "../lib/refresh.mjs";
import { login, logout, organizationKind, readSecret, status as authStatus, tokenPageUrl } from "../lib/auth.mjs";
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
import {
  toChars,
  parseRange,
  scanMarkers,
  validateRange,
  insertMarker,
  removeMarkers,
  locateText,
} from "../lib/inline.mjs";
import {
  parseId,
  buildCommentBody,
  commentQuery,
  threadQuery,
  commentSummary,
  commentHead,
} from "../lib/comments.mjs";
import {
  revisionQuery,
  validateRevisionPageSize,
  parseRevisionIds,
  revisionSummary,
  revisionHead,
  revisionOf,
  isCurrentRevision,
} from "../lib/history.mjs";
import { unifiedDiff, DIFF_CONTEXT_MAX } from "../lib/diff.mjs";

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
  "--inline-range",
  "--thread",
  "--to",
  "--status",
  "--order",
  "--ids",
  "--context",
  "--method",
  "--organization-id",
  "--client-id",
  "--scope",
  "--callback-timeout-ms",
  "--yc-profile",
  "--yc-bin",
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
  "--inline",
  "--page-level",
  "--no-open",
]);
/** Short aliases for the top-level `-h, --help` / `-v, --version`. */
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
    // Support the `--flag=value` form (e.g. `--rich-ui=yes`).
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
      if (verb === "locate") return { key: "page locate", handler: "locate", args };
      if (verb === "history") return { key: "page history", handler: "history", args };
      if (verb === "revision") return { key: "page revision", handler: "revision", args };
      if (verb === "diff") return { key: "page diff", handler: "diff", args };
      if (verb === "comments") {
        const sub = args[0];
        if (sub === "add" || sub === "reply" || sub === "delete") {
          throw new UsageError(`page comments: для записи используйте page comment ${sub} …`);
        }
        const listArgs = sub === "list" ? args.slice(1) : args;
        return { key: "page comments", handler: "comments", args: listArgs };
      }
      if (verb === "comment") {
        const sub = args[0];
        const rest2 = args.slice(1);
        if (sub === "list") return { key: "page comment list", handler: "commentList", args: rest2 };
        if (sub === "add") return { key: "page comment add", handler: "commentAdd", args: rest2 };
        if (sub === "reply") return { key: "page comment reply", handler: "commentReply", args: rest2 };
        if (sub === "delete") return { key: "page comment delete", handler: "commentDelete", args: rest2 };
        throw new UsageError(
          `page comment: неизвестная подкоманда «${sub ?? ""}» (list|add|reply|delete)`,
        );
      }
      if (verb === "create") return { key: "page create", handler: "create", args };
      if (verb === "edit") return { key: "page edit", handler: "edit", args };
      if (verb === "append") return { key: "page append", handler: "append", args };
      if (verb === "delete") return { key: "page delete", handler: "delete", args };
      throw new UsageError(
        `page: неизвестная подкоманда «${verb ?? ""}» (get|search|descendants|locate|history|revision|diff|comments|comment|create|edit|append|delete)`,
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
    case "auth": {
      const sub = rest[0];
      if (sub === "login") return { key: "auth login", handler: "authLogin", args: rest.slice(1) };
      if (sub === "logout") return { key: "auth logout", handler: "authLogout", args: rest.slice(1) };
      if (sub === "status") return { key: "auth status", handler: "authStatus", args: rest.slice(1) };
      throw new UsageError(`auth: неизвестная подкоманда ${sub ? `«${sub}»` : ""} (login|logout|status)`);
    }
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

/**
 * Comment text: positional words, or exactly one of `--file`/`--stdin`/`--content`.
 * @param {Record<string, any>} opts
 * @param {string[]} parts
 * @param {string} label
 * @returns {Promise<string>}
 */
async function commentTextFrom(opts, parts, label) {
  const used = CONTENT_FLAGS.filter((f) => f in opts);
  if (used.length > 1) {
    throw new UsageError(`${label}: укажите ровно один источник — --file, --stdin или --content`);
  }
  const positional = parts.join(" ").trim();
  if (used.length && positional) {
    throw new UsageError(`${label}: текст уже задан флагом; не дублируйте его позиционно`);
  }
  if (used.length) return String(await contentFrom(opts, { required: true, label }));
  if (positional) return positional;
  throw new UsageError(`${label}: нужен текст комментария (позиционно или --file/--stdin/--content)`);
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

/** Where an organization id comes from; shared by the prompt and the error. */
const ORG_HINT = "b1g… из консоли Yandex Cloud или числовой id Яндекс 360";

/**
 * Ask for whatever login input is missing (method, organization id) over one
 * readline interface: two sequential interfaces on the same stdin drop buffered
 * input, so both questions must share one.
 * @param {{ method: string | null, org: string, defaultMethod: string }} inputs
 * @returns {Promise<{ method: string, org: string }>}
 */
async function promptLoginInputs({ method, org, defaultMethod }) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  // Iterate instead of `rl.question`: the iterator keeps lines that arrived
  // before the question was asked (pasted or pre-buffered input).
  const lines = rl[Symbol.asyncIterator]();
  /** @param {string} text */
  const ask = async (text) => {
    process.stderr.write(text);
    const { value, done } = await lines.next();
    if (done) throw new UsageError("auth login: ввод прерван (EOF)");
    return String(value).trim();
  };
  try {
    if (!method) {
      const answer = (await ask(`Метод входа [browser/iam/token] (${defaultMethod}): `)).toLowerCase();
      if (!answer) method = defaultMethod;
      else if (answer === "browser" || answer === "iam" || answer === "token") method = answer;
      else throw new UsageError(`неизвестный метод входа: ${answer} (browser, iam, token)`);
    }
    if (!org) {
      const answer = await ask(`Organization id (${ORG_HINT}): `);
      if (!answer) throw new UsageError("auth login: organization id не введён");
      if (/\s/.test(answer)) throw new UsageError("auth login: organization id не содержит пробелов");
      org = answer;
    }
    return { method, org };
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
async function collectAll(fetchPage, maxPages = 100, initialCursor = undefined) {
  /** @type {any[]} */
  const results = [];
  let cursor = initialCursor;
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
    contour: c.org === "" ? null : "wiki",
    credentialSource: c.mtimeMs ? "file" : "env",
    scheme: c.scheme,
    organizationId: c.org,
    organizationKind: numericOrg ? "360" : "cloud",
    credential: path,
    credentialAgeHours: ageMs === null ? null : Number((ageMs / 3600000).toFixed(1)),
    token: tok,
  };
  // Rich form prints a `✓ Authenticated as …` block.
  const human = (p) => [
    `✓ Authenticated as ${p.identity.login}`,
    `  Contour: ${p.contour ?? "wiki"}`,
    `  Credential source: ${p.credentialSource}`,
    `  Credential scheme: ${p.scheme}`,
    `  Organization: ${p.organizationId} (${p.organizationKind})`,
    `  Credential file: ${p.credential}`,
    `  Age: ${ageH}`,
    `  Token: ${p.token}`,
  ].join("\n");
  out(opts, payload, human);
}

async function cmdAuthLogin(opts) {
  if (hasEnvCredential()) {
    throw new UsageError(
      "активен WIKI_IAM_TOKEN или WIKI_TOKEN; снимите переменную окружения, чтобы сохранить файл credential",
    );
  }
  const clientId = opts["--client-id"] || process.env.WIKI_OAUTH_CLIENT_ID || "";
  let method = opts["--method"] ? String(opts["--method"]) : null;
  if (method && method !== "browser" && method !== "token" && method !== "iam") {
    throw new UsageError(`auth login: неизвестный метод «${method}» (browser|iam|token)`);
  }
  let org = String(opts["--organization-id"] || process.env.WIKI_ORGANIZATION_ID || "");
  // `browser` is the nicer flow, but it cannot start without an OAuth app id;
  // then `iam` is the practical default (cloud/federated accounts).
  const defaultMethod = clientId ? "browser" : "iam";
  if ((!method || !org) && (opts["--no-input"] || !process.stdin.isTTY)) {
    if (!method) {
      throw new UsageError("auth login: укажите --method browser|iam|token (интерактивный выбор недоступен)");
    }
    throw new UsageError(
      `auth login: нужен organization id — ${ORG_HINT}; укажите --organization-id или WIKI_ORGANIZATION_ID`,
    );
  }
  if (!method || !org) ({ method, org } = await promptLoginInputs({ method, org, defaultMethod }));
  const timeoutMs = timeoutFrom(opts);
  const callbackTimeoutMs = opts["--callback-timeout-ms"] ? Number(opts["--callback-timeout-ms"]) : undefined;
  if (method === "browser" && !clientId) {
    throw new UsageError(
      "auth login: для browser-входа нужен OAuth client id — --client-id или WIKI_OAUTH_CLIENT_ID; для cloud/федеративных аккаунтов используйте --method iam",
    );
  }

  if (method === "token") {
    const page = tokenPageUrl({ clientId });
    if (page) {
      process.stderr.write(`Откройте страницу и вставьте токен:\n${page}\n`);
    } else {
      process.stderr.write("Откройте https://oauth.yandex.ru/ и создайте приложение с доступом к Wiki API,\n");
      process.stderr.write("либо используйте IAM-токен. Вставьте токен:\n");
    }
  }

  if (method === "browser" && organizationKind(org) === "cloud") {
    process.stderr.write("Для cloud organization OAuth-страница может не работать; при ошибке используйте --method iam.\n");
  }

  let result;
  if (method === "browser") {
    result = await login({
      method,
      org,
      clientId,
      scope: opts["--scope"],
      noOpen: Boolean(opts["--no-open"]),
      timeoutMs,
      callbackTimeoutMs,
      onAuthorizeUrl: (url) => process.stderr.write(`Откройте URL для входа:\n${url}\n`),
    });
  } else if (method === "token") {
    const token = await readSecret({ noInput: Boolean(opts["--no-input"]) });
    result = await login({ method, token, org, timeoutMs });
  } else if (method === "iam") {
    result = await login({
      method,
      org,
      timeoutMs,
      ycTimeoutMs: timeoutMs,
      ycProfile: opts["--yc-profile"] || process.env.WIKI_YC_PROFILE,
      ycBin: opts["--yc-bin"] || process.env.WIKI_YC_BIN,
    });
  } else {
    throw new UsageError(`auth login: неизвестный метод «${method}» (browser|token|iam)`);
  }

  if (result.creds.scheme === "iam") {
    process.stderr.write("IAM-токен действует около 12 часов; ywiki обновит его лениво при 401.\n");
  }

  const payload = {
    authenticated: true,
    method,
    scheme: result.creds.scheme,
    organization: result.creds.org,
    organizationKind: organizationKind(result.creds.org),
    credential: result.path,
    identity: result.identity,
  };
  const human = (p) => [
    `✓ Аутентификация выполнена (${p.method}, ${p.scheme})`,
    `  Организация: ${p.organization} (${p.organizationKind})`,
    `  Credential: ${p.credential}`,
    `  Проверка: ywiki whoami`,
  ].join("\n");
  out(opts, payload, human);
}

async function cmdAuthLogout(opts) {
  if (!opts["--yes"]) {
    if (opts["--no-input"] || !process.stdin.isTTY) {
      throw new UsageError("auth logout: нужно --yes (интерактивное подтверждение недоступно)");
    }
    const ok = await confirm("Удалить локальный credential? [y/N] ");
    if (!ok) {
      process.stderr.write("Отменено.\n");
      return;
    }
  }
  const result = logout();
  if (result.removed) {
    process.stderr.write("Локальный credential удалён; серверный токен остаётся действительным до истечения.\n");
  }
  const payload = {
    loggedOut: true,
    removed: result.removed,
    credential: result.path,
  };
  const human = (p) =>
    p.removed
      ? `✓ Локальный credential удалён: ${p.credential}`
      : `Локальный credential не найден: ${p.credential}`;
  out(opts, payload, human);
}

async function cmdAuthStatus(opts) {
  const s = authStatus();
  const human = (p) => {
    if (!p.present) return `Credential не найден: ${p.path}\n  Выполните: ywiki auth login`;
    const lines = [
      `✓ Credential: ${p.source === "env" ? "переменная окружения" : p.path}`,
      `  Схема: ${p.scheme}`,
      `  Организация: ${p.org} (${p.organizationKind})`,
      `  Токен: ${p.tokenPrefix}`,
    ];
    if (p.ageSeconds !== null) lines.push(`  Возраст: ${Math.round(p.ageSeconds / 60)} мин`);
    if (p.hasRefreshToken) lines.push("  Refresh token: есть");
    return lines.join("\n");
  };
  out(opts, s, human);
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

async function cmdCommentList(opts, slug) {
  if (!slug) throw new UsageError("page comment list: укажите slug");
  if (opts["--inline"] && opts["--page-level"]) {
    throw new UsageError("--inline и --page-level взаимоисключающие");
  }
  const threadId = "--thread" in opts ? intOpt(opts, "--thread", undefined) : undefined;
  const pageSize = intOpt(opts, "--limit", undefined);
  const cursor = typeof opts["--cursor"] === "string" ? opts["--cursor"] : undefined;
  const status = typeof opts["--status"] === "string" ? opts["--status"] : undefined;
  const order = typeof opts["--order"] === "string" ? opts["--order"] : undefined;
  if (status !== undefined && !["resolved", "unresolved"].includes(status)) {
    throw new UsageError("--status: допустимо resolved|unresolved");
  }
  if (order !== undefined && !["asc", "desc"].includes(order)) {
    throw new UsageError("--order: допустимо asc|desc");
  }

  const client = makeClient(opts);
  const page = await resolvePage(client, slug, { fields: "attributes" });
  const base =
    `/pages/${encodeURIComponent(String(page.id))}/comments` +
    (threadId === undefined ? "" : `/${encodeURIComponent(String(threadId))}/thread`);
  const queryOf = (cur) =>
    base +
    (threadId === undefined
      ? commentQuery({ pageSize, cursor: cur ?? cursor, status, order })
      : threadQuery({ pageSize, cursor: cur ?? cursor, order }));
  const fetchPage = (cur) => client.request(queryOf(cur));

  let results;
  let nextCursor = null;
  if (opts["--all"]) {
    ({ results, nextCursor } = await collectAll(fetchPage, 100, cursor));
  } else {
    const res = await fetchPage(cursor);
    results = Array.isArray(res.results) ? res.results : [];
    nextCursor = res.next_cursor ?? null;
  }

  if (opts["--inline"]) results = results.filter((c) => c.inline_text);
  if (opts["--page-level"]) results = results.filter((c) => !c.inline_text);

  const payload = {
    slug,
    id: page.id,
    thread: threadId ?? null,
    results: results.map(commentSummary),
    next_cursor: nextCursor,
  };
  const human = () => {
    if (!results.length) {
      return threadId === undefined
        ? `Комментариев нет для «${slug}».\nПодсказка: проверьте slug или используйте \`ywiki search\`.`
        : `В ветке #${threadId} нет ответов.`;
    }
    return results.map((c) => `${commentHead(c)}\n${c.body ?? ""}`).join("\n\n");
  };
  out(opts, payload, human);
}

async function cmdCommentAdd(opts, slug, textParts) {
  if (!slug) throw new UsageError("page comment add: укажите slug");
  const bodyText = await commentTextFrom(opts, textParts, "page comment add");
  const inlineRange = "--inline-range" in opts ? String(opts["--inline-range"]) : undefined;
  const client = makeWriteClient(opts);
  const page = await resolvePage(client, slug);
  if (page.attributes?.is_readonly) {
    throw new WikiError("access_denied", `страница «${slug}» доступна только для чтения`);
  }

  if (inlineRange === undefined) {
    const body = buildCommentBody({ body: bodyText });
    if (opts["--dry-run"]) {
      const payload = {
        dry_run: true,
        action: "comment add",
        slug,
        id: page.id,
        body: bodyText,
        inline_text: null,
        inline_range: null,
      };
      out(opts, payload, (p) => `dry-run: добавить комментарий к «${p.slug}» (id ${p.id}), ${Buffer.byteLength(p.body)} байт`);
      return;
    }
    const res = await client.request(`/pages/${encodeURIComponent(String(page.id))}/comments`, {
      method: "POST",
      body,
    });
    const payload = {
      comment_id: res?.id ?? null,
      page_id: page.id,
      slug,
      body: bodyText,
      inline_text: null,
      inline_range: null,
      created_at: res?.created_at ?? null,
    };
    out(opts, payload, (p) => `✓ Комментарий #${p.comment_id ?? "?"} добавлен к «${p.slug}» (id ${p.page_id})`);
    return;
  }

  if (page.page_type === "grid" || page.page_type === "cloud_page") {
    throw new UsageError(
      `page comment add: страница типа «${page.page_type}» не поддерживает инлайн-комментарии`,
    );
  }
  const revision = revisionFor(opts, page);
  const chars = toChars(page.content);
  const markers = scanMarkers(chars);
  const range = parseRange(inlineRange);
  const text = validateRange(chars, range, markers);
  const inserted = insertMarker(chars, range, 0);
  const body = buildCommentBody({ body: bodyText, inlineText: text });

  if (opts["--dry-run"]) {
    const payload = {
      dry_run: true,
      action: "comment add",
      slug,
      id: page.id,
      body: bodyText,
      inline_text: text,
      inline_range: { start: range.start, end: range.end },
      marker: inserted.marker,
      revision: revision ?? null,
      bytes_before: Buffer.byteLength(String(page.content ?? "")),
      bytes_after: Buffer.byteLength(inserted.content),
    };
    out(opts, payload, (p) => [
      `dry-run: добавить инлайн-комментарий к «${p.slug}» (id ${p.id})`,
      `  диапазон: ${p.inline_range.start}-${p.inline_range.end} → «${p.inline_text}»`,
      `  маркер: ${p.marker} (revision ${p.revision ?? "не отправляется"})`,
      `  байт: ${p.bytes_before} → ${p.bytes_after}`,
    ].join("\n"));
    return;
  }

  const comment = await client.request(`/pages/${encodeURIComponent(String(page.id))}/comments`, {
    method: "POST",
    body,
  });
  const commentId = comment?.id;
  if (commentId === undefined || commentId === null) {
    throw new WikiError("unavailable", "API не вернул id созданного комментария");
  }
  const marker = insertMarker(chars, range, commentId);
  let updated;
  try {
    updated = await client.request(
      `/pages/${encodeURIComponent(String(page.id))}` +
        writeQuery({ fields: "last_revision_id,attributes", silent: Boolean(opts["--silent"]) }),
      { method: "POST", body: buildEditBody({ content: marker.content, revision }) },
    );
  } catch (e) {
    let cleaned = false;
    try {
      await client.request(
        `/pages/${encodeURIComponent(String(page.id))}/comments/${encodeURIComponent(String(commentId))}`,
        { method: "DELETE" },
      );
      cleaned = true;
    } catch {
      // Best effort: the comment may already be gone or the API may refuse.
    }
    const tail = cleaned
      ? "Комментарий откатан, страница не изменена."
      : `Комментарий #${commentId} остался — удалите его вручную.`;
    const kind = e && e.kind && e.kind in EXIT ? e.kind : "unavailable";
    throw new WikiError(kind, `${(e && e.message) || e}. ${tail}`, { status: e && e.status });
  }

  const payload = {
    comment_id: commentId,
    page_id: page.id,
    slug,
    body: bodyText,
    inline_text: text,
    inline_range: { start: range.start, end: range.end },
    marker: marker.marker,
    last_revision_id: updated?.last_revision_id ?? null,
    modified_at: updated?.attributes?.modified_at ?? null,
  };
  out(opts, payload, (p) => [
    `✓ Инлайн-комментарий #${p.comment_id} добавлен к «${p.slug}» (id ${p.page_id})`,
    `  диапазон: ${p.inline_range.start}-${p.inline_range.end} → «${p.inline_text}»`,
    `  ревизия: ${p.last_revision_id ?? "н/д"}`,
  ].join("\n"));
}

async function cmdCommentReply(opts, slug, threadIdArg, textParts) {
  if (!slug) throw new UsageError("page comment reply: укажите slug");
  if (!threadIdArg) throw new UsageError("page comment reply: укажите thread-id");
  const threadId = parseId(threadIdArg, "page comment reply");
  const parentId = "--to" in opts ? intOpt(opts, "--to", undefined) : threadId;
  const bodyText = await commentTextFrom(opts, textParts, "page comment reply");
  const client = makeWriteClient(opts);
  const page = await resolvePage(client, slug, { fields: "attributes" });
  if (page.attributes?.is_readonly) {
    throw new WikiError("access_denied", `страница «${slug}» доступна только для чтения`);
  }
  const body = buildCommentBody({ body: bodyText, parentId, threadId });

  if (opts["--dry-run"]) {
    const payload = {
      dry_run: true,
      action: "comment reply",
      slug,
      id: page.id,
      parent_id: parentId,
      thread_id: threadId,
      body: bodyText,
    };
    out(opts, payload, (p) => `dry-run: ответить в ветку #${p.thread_id} (parent #${p.parent_id}) на «${p.slug}»`);
    return;
  }

  const res = await client.request(`/pages/${encodeURIComponent(String(page.id))}/comments`, {
    method: "POST",
    body,
  });
  const payload = {
    comment_id: res?.id ?? null,
    page_id: page.id,
    slug,
    parent_id: parentId,
    thread_id: threadId,
    body: bodyText,
    created_at: res?.created_at ?? null,
  };
  out(opts, payload, (p) => `✓ Ответ #${p.comment_id ?? "?"} добавлен в ветку #${p.thread_id} на «${p.slug}»`);
}

async function cmdCommentDelete(opts, slug, commentIdArg) {
  if (!slug) throw new UsageError("page comment delete: укажите slug");
  if (!commentIdArg) throw new UsageError("page comment delete: укажите id комментария");
  const commentId = parseId(commentIdArg, "page comment delete");
  const client = makeWriteClient(opts);
  const page = await resolvePage(client, slug);
  if (page.attributes?.is_readonly) {
    throw new WikiError("access_denied", `страница «${slug}» доступна только для чтения`);
  }
  const chars = toChars(page.content);
  const markers = scanMarkers(chars);
  const marker = markers.find((m) => m.id === commentId) ?? null;
  const revision = marker ? revisionFor(opts, page) : undefined;

  if (opts["--dry-run"]) {
    const payload = {
      dry_run: true,
      action: "comment delete",
      slug,
      id: page.id,
      comment_id: commentId,
      marker: marker ? { start: marker.start, end: marker.end, text: marker.text } : null,
      revision: revision ?? null,
    };
    out(opts, payload, (p) => [
      `dry-run: удалить комментарий #${p.comment_id} на «${p.slug}» (id ${p.id})`,
      p.marker
        ? `  маркер будет снят: ${p.marker.start}-${p.marker.end} → «${p.marker.text}»`
        : "  маркера в тексте нет — страница не изменится",
    ].join("\n"));
    return;
  }

  if (!opts["--yes"]) {
    if (opts["--no-input"] || !process.stdin.isTTY) {
      throw new UsageError("page comment delete: нужно явное подтверждение — используйте --yes (или --dry-run)");
    }
    const ok = await confirm(`Удалить комментарий #${commentId} на «${slug}»? [y/N] `);
    if (!ok) throw new UsageError("page comment delete: отменено");
  }

  const res = await client.request(
    `/pages/${encodeURIComponent(String(page.id))}/comments/${encodeURIComponent(String(commentId))}`,
    { method: "DELETE" },
  );

  let markerRemoved = false;
  let lastRevisionId = null;
  let markerError = null;
  if (marker) {
    const removed = removeMarkers(chars, commentId);
    try {
      const updated = await client.request(
        `/pages/${encodeURIComponent(String(page.id))}` +
          writeQuery({ fields: "last_revision_id,attributes", silent: Boolean(opts["--silent"]) }),
        { method: "POST", body: buildEditBody({ content: removed.content, revision }) },
      );
      markerRemoved = true;
      lastRevisionId = updated?.last_revision_id ?? null;
    } catch (e) {
      markerError = (e && e.message) || String(e);
    }
  }

  const payload = {
    comment_id: commentId,
    page_id: page.id,
    slug,
    comments_count: res?.comments_count ?? null,
    marker_removed: markerRemoved,
    marker_error: markerError,
    last_revision_id: lastRevisionId,
  };
  out(opts, payload, (p) => {
    const head = `✓ Комментарий #${p.comment_id} удалён (id ${p.page_id})`;
    if (!p.marker_removed && !p.marker_error) return `${head}\n  маркера в тексте не было`;
    if (p.marker_removed) return `${head}\n  маркер снят, ревизия ${p.last_revision_id ?? "н/д"}`;
    return `${head}\n  ВНИМАНИЕ: маркер остался — ${p.marker_error}`;
  });
  if (markerError) process.exitCode = EXIT.conflict;
}

async function cmdLocate(opts, slug, queryParts) {
  if (!slug) throw new UsageError("page locate: укажите slug");
  const query = queryParts.join(" ").trim();
  if (!query) throw new UsageError("page locate: укажите текст для поиска");
  const limit = intOpt(opts, "--limit", 20);
  const client = makeClient(opts);
  const page = await resolvePage(client, slug);
  const chars = toChars(page.content);
  const markers = scanMarkers(chars);
  const { total, occurrences } = locateText(chars, query, { limit, markers });
  const payload = { slug: page.slug ?? slug, id: page.id, query, count: total, occurrences };
  const human = () => {
    if (!total) return `Не найдено «${query}» на «${slug}».`;
    const lines = [`# ${page.title ?? slug}`, `slug: ${slug}`, `query: ${query}`, `count: ${total}`, ""];
    for (const o of occurrences) {
      lines.push(`${o.start}-${o.end} (${o.line}:${o.column})${o.inside_marker ? " [внутри маркера]" : ""}`);
      lines.push(`  ${o.context}`);
    }
    if (total > occurrences.length) {
      lines.push("", `Показаны первые ${occurrences.length}; увеличьте --limit, чтобы увидеть больше.`);
    }
    return lines.join("\n");
  };
  out(opts, payload, human);
}

async function cmdHistory(opts, slug) {
  if (!slug) throw new UsageError("page history: укажите slug");
  const pageSize = intOpt(opts, "--limit", undefined);
  if (pageSize !== undefined) validateRevisionPageSize(pageSize);
  const cursor = typeof opts["--cursor"] === "string" ? opts["--cursor"] : undefined;
  const ids = "--ids" in opts ? parseRevisionIds(opts["--ids"]) : undefined;
  const client = makeClient(opts);
  const page = await resolvePage(client, slug, { fields: "last_revision_id" });
  const base = `/pages/${encodeURIComponent(String(page.id))}/revisions`;
  const fetchPage = (cur) => client.request(base + revisionQuery({ pageSize, cursor: cur, ids }));

  let results;
  let nextCursor = null;
  if (opts["--all"]) {
    ({ results, nextCursor } = await collectAll(fetchPage, 100, cursor));
  } else {
    const res = await fetchPage(cursor);
    results = Array.isArray(res.results) ? res.results : [];
    nextCursor = res.next_cursor ?? null;
  }

  const last = page.last_revision_id ?? null;
  const payload = {
    slug: page.slug ?? slug,
    id: page.id,
    last_revision_id: last,
    results: results.map(revisionSummary),
    next_cursor: nextCursor,
  };
  const human = () => {
    if (!results.length) {
      return `История пуста для «${slug}».\nПодсказка: проверьте slug или используйте \`ywiki search\`.`;
    }
    return results
      .map((r) => revisionHead(r, { current: isCurrentRevision(r, last) }))
      .join("\n");
  };
  out(opts, payload, human);
}

async function cmdRevision(opts, slug, revisionArg) {
  if (!slug) throw new UsageError("page revision: укажите slug");
  if (!revisionArg) throw new UsageError("page revision: укажите id ревизии");
  const revisionId = parseId(revisionArg, "page revision");
  const offset = intOpt(opts, "--offset", 0);
  const limit = intOpt(opts, "--limit", undefined);
  const fields = "content,attributes,last_revision_id";
  const client = makeClient(opts);
  const page = await client.request(
    `/pages?slug=${encodeSlug(slug)}&revision_id=${revisionId}&fields=${encodeURIComponent(fields)}`,
  );
  const content = typeof page.content === "string" ? page.content : "";
  const c = clip(content, offset, limit);
  const revision = revisionOf(page);
  const current = revisionId === Number(page.last_revision_id);
  const payload = {
    slug: page.slug ?? slug,
    id: page.id,
    revision_id: revisionId,
    title: page.title ?? null,
    current,
    revision,
    content: c.text,
    truncated: c.truncated,
    next_offset: c.truncated ? c.nextOffset : null,
  };
  const human = (p) => {
    const who = p.revision?.author ? ` — ${p.revision.author}` : "";
    const when = p.revision?.created_at ? ` (${p.revision.created_at})` : "";
    const lines = [
      `# ${p.title ?? p.slug}`,
      `revision: ${p.revision_id}${who}${when}${p.current ? " — current" : ""}`,
      `slug: ${p.slug}`,
    ];
    if (!content.trim()) {
      lines.push("", "EMPTY: ревизия существует, содержимого нет");
      return lines.join("\n");
    }
    lines.push("", p.content);
    const hint = clipHint(c);
    if (hint) lines.push("", hint);
    return lines.join("\n");
  };
  out(opts, payload, human);
}

async function cmdDiff(opts, slug, fromArg, toArg) {
  if (!slug) throw new UsageError("page diff: укажите slug");
  if (!fromArg || !toArg) throw new UsageError("page diff: укажите две ревизии — <from> <to>");
  const from = parseId(fromArg, "page diff");
  const to = parseId(toArg, "page diff");
  const context = intOpt(opts, "--context", 3);
  if (context > DIFF_CONTEXT_MAX) {
    throw new UsageError(`--context: допустимо 0–${DIFF_CONTEXT_MAX}`);
  }
  const client = makeClient(opts);
  const fields = "content,last_revision_id";
  const load = (revision) =>
    client.request(
      `/pages?slug=${encodeSlug(slug)}&revision_id=${revision}&fields=${encodeURIComponent(fields)}`,
    );
  const [left, right] = await Promise.all([load(from), load(to)]);
  const d = unifiedDiff(
    typeof left.content === "string" ? left.content : "",
    typeof right.content === "string" ? right.content : "",
    { context, labelFrom: `${slug} revision ${from}`, labelTo: `${slug} revision ${to}` },
  );
  const payload = {
    slug: left.slug ?? slug,
    id: left.id ?? right.id ?? null,
    from_revision_id: from,
    to_revision_id: to,
    from: revisionOf(left),
    to: revisionOf(right),
    changed: d.changed,
    added: d.added,
    removed: d.removed,
    hunks: d.hunks,
    coarse: d.coarse,
    patch: d.patch,
  };
  const human = (p) => {
    if (!p.changed) return `Ревизии ${p.from_revision_id} и ${p.to_revision_id} совпадают.`;
    if (!p.coarse) return p.patch;
    return `${p.patch}\n(грубое сравнение: объём превысил лимит построчного diff)`;
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
      process.stdout.write(JSON.stringify({ version: VERSION, contour: "wiki" }) + "\n");
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
    case "authLogin":
      await cmdAuthLogin(opts);
      break;
    case "authLogout":
      await cmdAuthLogout(opts);
      break;
    case "authStatus":
      await cmdAuthStatus(opts);
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
      await cmdCommentList(opts, resolved.args[0]);
      break;
    case "commentList":
      await cmdCommentList(opts, resolved.args[0]);
      break;
    case "commentAdd":
      await cmdCommentAdd(opts, resolved.args[0], resolved.args.slice(1));
      break;
    case "commentReply":
      await cmdCommentReply(opts, resolved.args[0], resolved.args[1], resolved.args.slice(2));
      break;
    case "commentDelete":
      await cmdCommentDelete(opts, resolved.args[0], resolved.args[1]);
      break;
    case "locate":
      await cmdLocate(opts, resolved.args[0], resolved.args.slice(1));
      break;
    case "history":
      await cmdHistory(opts, resolved.args[0]);
      break;
    case "revision":
      await cmdRevision(opts, resolved.args[0], resolved.args[1]);
      break;
    case "diff":
      await cmdDiff(opts, resolved.args[0], resolved.args[1], resolved.args[2]);
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
