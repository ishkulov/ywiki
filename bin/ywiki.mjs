#!/usr/bin/env node
// ywiki — read-only CLI for Yandex Wiki, using the existing legacy IAM credential.
//
// Command tree, output modes, error envelope and exit codes mirror `the legacy CLI`
// so agents and scripts can treat both tools the same way. The token is read
// from the credential file by lib/credentials.mjs, never passed via argv, and
// is masked everywhere it could appear in output.

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
} from "../lib/output.mjs";

/** Error whose `kind` is always `usage`. */
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  "--offset",
  "--limit",
  "--depth",
  "--fields",
  "--cursor",
  "--timeout",
  "--timeout-ms",
  "--rich-ui",
]);
const BOOL_FLAGS = new Set(["--json", "--no-cache", "--no-input", "--all", "--help", "-h", "--version"]);

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
      opts[a === "-h" ? "--help" : a] = true;
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

/** @param {string} q @returns {string} */
export function encodeSlug(q) {
  return String(q)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
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
      throw new UsageError(`page: неизвестная подкоманда «${verb ?? ""}» (get|search|descendants)`);
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

function makeClient(opts) {
  const timeoutMs = "--timeout-ms" in opts
    ? intOpt(opts, "--timeout-ms", undefined)
    : intOpt(opts, "--timeout", undefined) === undefined
      ? undefined
      : intOpt(opts, "--timeout", undefined) * 1000;
  return createClient({
    noCache: Boolean(opts["--no-cache"]),
    timeoutMs,
    refresh: () => refreshOnce({}),
  });
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
  const human = (p) => [
    `login:      ${p.identity.login}`,
    `scheme:     ${p.scheme}`,
    `org:        ${p.organizationId}`,
    `credential: ${p.credential}`,
    `возраст:    ${ageH}`,
    `token:      ${p.token}`,
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
