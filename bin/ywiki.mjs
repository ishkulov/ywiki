#!/usr/bin/env node
// ywiki — read-only CLI for Yandex Wiki, using the existing legacy IAM credential.
//
// The token is read from the credential file by lib/credentials.mjs, never
// passed via argv, and is masked everywhere it could appear in output.

import { credentials, credentialPath, redact, AuthError } from "../lib/credentials.mjs";
import { createClient } from "../lib/client.mjs";
import { refreshOnce } from "../lib/refresh.mjs";
import { clip, clipHint, usageText, errorHint, VERSION, EXIT } from "../lib/output.mjs";

const USAGE_KINDS = new Set(["usage"]);

/** Parse argv into positionals and a flat options map. */
function parseArgs(argv) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string | boolean>} */
  const opts = {};
  const valueFlags = new Set(["--offset", "--limit", "--depth", "--timeout"]);
  const boolFlags = new Set(["--json", "--no-cache", "--help", "-h", "--version"]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`флагу ${a} нужно значение`);
      opts[a] = v;
      i++;
    } else if (boolFlags.has(a)) {
      opts[a === "-h" ? "--help" : a] = true;
    } else if (a.startsWith("--")) {
      throw new UsageError(`неизвестный флаг: ${a}`);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, opts };
}

class UsageError extends Error {}

function intOpt(opts, name, def) {
  if (!(name in opts)) return def;
  const n = Number(opts[name]);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new UsageError(`флаг ${name}: нужно целое ≥ 0`);
  return n;
}

/** Encode a slug per path segment, preserving "/" and encoding non-ASCII. */
export function encodeSlug(slug) {
  return String(slug)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function makeClient(opts) {
  const timeoutS = intOpt(opts, "--timeout", undefined);
  return createClient({
    noCache: Boolean(opts["--no-cache"]),
    timeoutMs: timeoutS === undefined ? undefined : timeoutS * 1000,
    refresh: () => refreshOnce({}),
  });
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function line(s = "") {
  process.stdout.write(s + "\n");
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
  if (opts["--json"]) {
    printJson({ login: me.username, scheme: c.scheme, org: c.org, credential: path, age: ageH, token: tok });
    return;
  }
  line(`login:      ${me.username}`);
  line(`scheme:     ${c.scheme}`);
  line(`org:        ${c.org}`);
  line(`credential: ${path}`);
  line(`возраст:    ${ageH}`);
  line(`token:      ${tok}`);
}

async function cmdGet(opts, slug) {
  if (!slug) throw new UsageError("get: укажите slug");
  const offset = intOpt(opts, "--offset", 0);
  const limit = intOpt(opts, "--limit", undefined);
  const client = makeClient(opts);
  const page = await client.request(
    `/pages?slug=${encodeSlug(slug)}&fields=content,attributes,last_revision_id`,
  );
  const content = typeof page.content === "string" ? page.content : "";
  if (opts["--json"]) {
    const c = clip(content, offset, limit);
    printJson({ slug: page.slug, title: page.title, modified_at: page.attributes?.modified_at, content: c.text, truncated: c.truncated, next_offset: c.truncated ? c.nextOffset : null });
    return;
  }
  line(`# ${page.title}`);
  line(`slug: ${page.slug}`);
  if (page.attributes?.modified_at) line(`modified: ${page.attributes.modified_at}`);
  line("");
  if (!content.trim()) {
    line("EMPTY: страница существует, содержимого нет");
    return;
  }
  const c = clip(content, offset, limit);
  line(c.text);
  const hint = clipHint(c);
  if (hint) line("\n" + hint);
}

async function cmdSearch(opts, query) {
  if (!query) throw new UsageError("search: укажите запрос");
  const limit = intOpt(opts, "--limit", undefined);
  const client = makeClient(opts);
  const res = await client.request("/search", {
    method: "POST",
    body: { query, ...(limit === undefined ? {} : { limit }), filters: { type: "page" } },
  });
  const results = Array.isArray(res.results) ? res.results : [];
  if (opts["--json"]) {
    printJson({ query, results: results.map((r) => ({ slug: r.slug, title: r.title })), next_cursor: res.next_cursor ?? null });
    return;
  }
  if (!results.length) {
    line(`Ничего не найдено по запросу «${query}».`);
    line("Подсказка: проверьте формулировку, попробуйте другой термин.");
    return;
  }
  for (const r of results) line(`${r.slug} — ${r.title}`);
}

async function cmdTree(opts, slug) {
  const pageSize = intOpt(opts, "--limit", undefined);
  const client = makeClient(opts);
  const q = `/pages/descendants?slug=${encodeSlug(slug ?? "")}` + (pageSize === undefined ? "" : `&page_size=${pageSize}`);
  const res = await client.request(q);
  const results = Array.isArray(res.results) ? res.results : [];
  if (opts["--json"]) {
    printJson({ slug: slug ?? "", results, next_cursor: res.next_cursor ?? null });
    return;
  }
  if (!results.length) {
    line(`Подстраниц нет (или нет доступа) для «${slug ?? ""}».`);
    line("Подсказка: проверьте slug или используйте `ywiki search`.");
    return;
  }
  // /pages/descendants returns {id, slug} only (no title) — see T0 notes.
  for (const r of results) line(r.slug);
}

async function cmdSpaces(opts) {
  const client = makeClient(opts);
  const res = await client.request("/spaces");
  const results = Array.isArray(res.results) ? res.results : [];
  if (opts["--json"]) {
    printJson({ results: results.map((s) => ({ slug: s.slug, title: s.title })), next_cursor: res.next_cursor ?? null });
    return;
  }
  if (!results.length) {
    line("Пространств не найдено.");
    return;
  }
  for (const s of results) line(`${s.slug} — ${s.title}`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`ywiki: ${e.message}\n\n${usageText()}\n`);
      process.exit(EXIT.usage);
    }
    throw e;
  }
  const { positionals, opts } = parsed;

  if (opts["--version"]) {
    line(`ywiki ${VERSION}`);
    return;
  }
  if (opts["--help"] || positionals.length === 0) {
    line(usageText());
    process.exit(positionals.length === 0 && !opts["--help"] ? EXIT.usage : EXIT.ok);
  }

  const [cmd, ...rest] = positionals;
  switch (cmd) {
    case "whoami":
      await cmdWhoami(opts);
      break;
    case "get":
      await cmdGet(opts, rest[0]);
      break;
    case "search":
      await cmdSearch(opts, rest.join(" "));
      break;
    case "tree":
      await cmdTree(opts, rest[0]);
      break;
    case "spaces":
      await cmdSpaces(opts);
      break;
    default:
      throw new UsageError(`неизвестная команда: ${cmd}`);
  }
}

main().catch((e) => {
  const isUsage = e instanceof UsageError || (e && e.kind && USAGE_KINDS.has(e.kind));
  if (isUsage) {
    process.stderr.write(`ywiki: ${e.message}\n\n${usageText()}\n`);
    process.exit(EXIT.usage);
  }
  if (e instanceof AuthError) {
    process.stderr.write(`ywiki: ${errorHint(redact(e.message))}\n`);
    process.exit(EXIT.auth_unavailable);
  }
  const kind = e && e.kind;
  const code = kind && kind in EXIT ? EXIT[kind] : EXIT.upstream_unavailable;
  process.stderr.write(`ywiki: ${redact((e && e.message) || e)}\n`);
  if (code === EXIT.auth_unavailable) process.stderr.write("Подсказка: task opencode:the legacy CLI-refresh\n");
  process.exit(code);
});
