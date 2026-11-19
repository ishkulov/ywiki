// ywiki/tests/comments.test.mjs
// End-to-end tests for comments and inline comments. A local stub server records
// method/path/body; no real network. Credentials come from ENV, cache is tmp.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ywiki.mjs");

const IAM_PREFIX = ["t", "1", "."].join("");
const IAM = IAM_PREFIX + "x".repeat(40);

/** @type {import("node:http").Server} */
let server;
let baseUrl;
let cacheDir;
/** @type {{method:string,url:string,body:any}[]} */
let seen = [];

const PAGES = {
  "team/reg": {
    id: 42,
    title: "Регламент",
    page_type: "wysiwyg",
    content: "Первый абзац. Второй абзац.",
    attributes: { modified_at: "2026-01-01T00:00:00Z" },
    last_revision_id: 5,
  },
  "team/readonly": {
    id: 43,
    title: "Только чтение",
    page_type: "wysiwyg",
    content: "x",
    attributes: { is_readonly: true, modified_at: "2026-01-01T00:00:00Z" },
    last_revision_id: 5,
  },
  "team/grid": {
    id: 44,
    title: "Таблица",
    page_type: "grid",
    content: "x",
    attributes: { modified_at: "2026-01-01T00:00:00Z" },
    last_revision_id: 5,
  },
  "team/conflict": {
    id: 45,
    title: "Конфликт",
    page_type: "wysiwyg",
    content: "abc",
    attributes: { modified_at: "2026-01-01T00:00:00Z" },
    last_revision_id: "conflict",
  },
  "team/inline": {
    id: 46,
    title: "Инлайн",
    page_type: "wysiwyg",
    content: "До &[фрагмент](100) после",
    attributes: { modified_at: "2026-01-01T00:00:00Z" },
    last_revision_id: 5,
  },
  "team/multiline": {
    id: 47,
    title: "Многострочная",
    page_type: "wysiwyg",
    content: "a\nb",
    attributes: { modified_at: "2026-01-01T00:00:00Z" },
    last_revision_id: 5,
  },
};

const TOP_COMMENTS = [
  {
    id: 100,
    body: "Первый",
    inline_text: null,
    author: { username: "alice" },
    created_at: "2026-01-01T00:00:00Z",
    resolve_status: "unresolved",
    thread_info: { total_posts: 2 },
  },
  {
    id: 101,
    body: "Инлайн",
    inline_text: "абзац",
    author: { username: "bob" },
    created_at: "2026-01-02T00:00:00Z",
    resolve_status: "unresolved",
    thread_info: { total_posts: 0 },
  },
];

const THREAD_100 = [
  {
    id: 102,
    body: "Ответ",
    inline_text: null,
    parent_id: 100,
    thread_id: 100,
    author: { username: "carol" },
    created_at: "2026-01-03T00:00:00Z",
    resolve_status: "unresolved",
    thread_info: { total_posts: 0 },
  },
];

before(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "ywiki-comments-"));
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      seen.push({ method: req.method, url: req.url, body });
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (req.method === "GET" && url.pathname === "/v1/pages") {
        const slug = url.searchParams.get("slug");
        const page = PAGES[slug];
        if (!page) return send(404, { error_code: "NOT_FOUND" });
        return send(200, { ...page, slug });
      }

      if (req.method === "GET" && /^\/v1\/pages\/\d+\/comments$/.test(url.pathname)) {
        const id = Number(url.pathname.split("/")[3]);
        if (id === 46) return send(200, { results: [TOP_COMMENTS[0]], next_cursor: null });
        return send(200, { results: TOP_COMMENTS, next_cursor: null });
      }

      if (req.method === "GET" && /^\/v1\/pages\/\d+\/comments\/\d+\/thread$/.test(url.pathname)) {
        return send(200, { results: THREAD_100, next_cursor: null });
      }

      if (req.method === "POST" && /^\/v1\/pages\/\d+\/comments$/.test(url.pathname)) {
        return send(200, {
          id: 200,
          body: body?.body,
          inline_text: body?.inline_text ?? null,
          parent_id: body?.parent_id ?? null,
          thread_id: body?.thread_id ?? null,
          author: { username: "me" },
          created_at: "2026-01-04T00:00:00Z",
          resolve_status: "unresolved",
          thread_info: { total_posts: 0 },
        });
      }

      if (req.method === "POST" && /^\/v1\/pages\/\d+$/.test(url.pathname)) {
        if (body?.revision === "conflict") return send(409, { error_code: "CONFLICT" });
        return send(200, {
          id: Number(url.pathname.split("/")[3]),
          slug: "team/reg",
          last_revision_id: 6,
          attributes: { modified_at: "2026-01-05T00:00:00Z" },
        });
      }

      if (req.method === "DELETE" && /^\/v1\/pages\/\d+\/comments\/\d+$/.test(url.pathname)) {
        return send(200, { comments_count: 0 });
      }

      return send(404, { error_code: "NOT_FOUND" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

after(() => {
  server.close();
});

/**
 * @param {string[]} args
 * @param {Record<string,string>} [extraEnv]
 */
function run(args, extraEnv = {}) {
  const env = {
    ...process.env,
    WIKI_BASE_URL: baseUrl,
    WIKI_IAM_TOKEN: IAM,
    WIKI_ORGANIZATION_ID: "123",
    WIKI_CACHE_DIR: cacheDir,
    ...extraEnv,
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, "--no-cache", ...args], { encoding: "utf8", env }, (err, stdout, stderr) => {
      resolve({ status: err && typeof err.code === "number" ? err.code : 0, stdout, stderr });
    });
  });
}

/** @param {string} method @param {RegExp} re */
function find(method, re) {
  return seen.find((s) => s.method === method && re.test(s.url));
}

test("page comment list resolves the page and pipes JSON", async () => {
  seen = [];
  const r = await run(["page", "comment", "list", "team/reg"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.slug, "team/reg");
  assert.equal(j.id, 42);
  assert.equal(j.results.length, 2);
  assert.deepEqual(j.results[0], {
    id: 100,
    body: "Первый",
    inline_text: null,
    parent_id: null,
    thread_id: 100,
    author: "alice",
    created_at: "2026-01-01T00:00:00Z",
    resolve_status: "unresolved",
    reply_count: 2,
    is_deleted: false,
  });
  assert.ok(find("GET", /^\/v1\/pages\/42\/comments$/));
});

test("page comment list --thread calls the thread endpoint", async () => {
  seen = [];
  const r = await run(["page", "comment", "list", "team/reg", "--thread", "100"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.results.length, 1);
  assert.equal(j.results[0].id, 102);
  assert.ok(find("GET", /^\/v1\/pages\/42\/comments\/100\/thread$/));
});

test("page comment list passes status, order and page_size", async () => {
  seen = [];
  const r = await run([
    "page", "comment", "list", "team/reg",
    "--status", "unresolved", "--order", "asc", "--limit", "5",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const get = find("GET", /^\/v1\/pages\/42\/comments\?/);
  assert.ok(get);
  assert.match(get.url, /page_size=5/);
  assert.match(get.url, /status_filter=unresolved/);
  assert.match(get.url, /order_by=created_at/);
  assert.match(get.url, /order_direction=asc/);
});

test("page comment list --inline filters page-level comments out", async () => {
  const r = await run(["page", "comment", "list", "team/reg", "--inline"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.results.map((c) => c.id), [101]);
});

test("page comment add posts a page-level comment", async () => {
  seen = [];
  const r = await run(["page", "comment", "add", "team/reg", "Новый", "комментарий"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.comment_id, 200);
  const post = find("POST", /^\/v1\/pages\/42\/comments$/);
  assert.deepEqual(post.body, { body: "Новый комментарий" });
});

test("page comment add accepts --content as the body source", async () => {
  seen = [];
  const r = await run(["page", "comment", "add", "team/reg", "--content", "Из флага"]);
  assert.equal(r.status, 0, r.stderr);
  const post = find("POST", /^\/v1\/pages\/42\/comments$/);
  assert.deepEqual(post.body, { body: "Из флага" });
});

test("page comment add --inline-range creates the comment and inserts the marker", async () => {
  seen = [];
  const r = await run(["page", "comment", "add", "team/reg", "Инлайн", "--inline-range", "0-6"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.comment_id, 200);
  assert.equal(j.inline_text, "Первый");
  assert.equal(j.marker, "&[Первый](200)");
  const comment = find("POST", /^\/v1\/pages\/42\/comments$/);
  assert.deepEqual(comment.body, { body: "Инлайн", inline_text: "Первый" });
  const pagePost = find("POST", /^\/v1\/pages\/42\?/);
  assert.deepEqual(pagePost.body, {
    content: "&[Первый](200) абзац. Второй абзац.",
    revision: "5",
  });
});

test("page comment add --inline-range --dry-run sends nothing", async () => {
  seen = [];
  const r = await run(["page", "comment", "add", "team/reg", "Инлайн", "--inline-range", "0-6", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dry_run, true);
  assert.equal(j.inline_text, "Первый");
  assert.equal(j.marker, "&[Первый](0)");
  assert.equal(seen.filter((s) => s.method === "POST").length, 0);
});

test("page comment add --inline-range rolls the comment back on a page conflict", async () => {
  seen = [];
  const r = await run(["page", "comment", "add", "team/conflict", "Инлайн", "--inline-range", "0-3"]);
  assert.equal(r.status, 6, r.stderr);
  assert.match(r.stderr, /откатан|CONFLICT|конфликт/i);
  assert.ok(find("POST", /^\/v1\/pages\/45\/comments$/));
  assert.ok(find("POST", /^\/v1\/pages\/45\?/));
  assert.ok(find("DELETE", /^\/v1\/pages\/45\/comments\/200$/));
});

test("page comment add rejects a range on a grid page", async () => {
  seen = [];
  const r = await run(["page", "comment", "add", "team/grid", "x", "--inline-range", "0-1"]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(seen.filter((s) => s.method === "POST").length, 0);
});

test("page comment add rejects a read-only page", async () => {
  const r = await run(["page", "comment", "add", "team/readonly", "x"]);
  assert.equal(r.status, 4, r.stderr);
});

test("page comment add rejects an out-of-bounds range before writing", async () => {
  seen = [];
  const r = await run(["page", "comment", "add", "team/reg", "x", "--inline-range", "0-999"]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(seen.filter((s) => s.method === "POST").length, 0);
});

test("page comment add rejects a range crossing a newline", async () => {
  const r = await run(["page", "comment", "add", "team/multiline", "x", "--inline-range", "0-3"]);
  assert.equal(r.status, 2, r.stderr);
});

test("page comment reply sets parent_id and thread_id", async () => {
  seen = [];
  const r = await run(["page", "comment", "reply", "team/reg", "100", "Ответ"]);
  assert.equal(r.status, 0, r.stderr);
  const post = find("POST", /^\/v1\/pages\/42\/comments$/);
  assert.deepEqual(post.body, { body: "Ответ", parent_id: 100, thread_id: 100 });
});

test("page comment reply --to answers inside the thread", async () => {
  seen = [];
  const r = await run(["page", "comment", "reply", "team/reg", "100", "--to", "102", "Ответ"]);
  assert.equal(r.status, 0, r.stderr);
  const post = find("POST", /^\/v1\/pages\/42\/comments$/);
  assert.deepEqual(post.body, { body: "Ответ", parent_id: 102, thread_id: 100 });
});

test("page comment delete removes the comment and its marker", async () => {
  seen = [];
  const r = await run(["page", "comment", "delete", "team/inline", "100", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.marker_removed, true);
  assert.ok(find("DELETE", /^\/v1\/pages\/46\/comments\/100$/));
  const pagePost = find("POST", /^\/v1\/pages\/46\?/);
  assert.deepEqual(pagePost.body, { content: "До фрагмент после", revision: "5" });
});

test("page comment delete without a marker only deletes the comment", async () => {
  seen = [];
  const r = await run(["page", "comment", "delete", "team/reg", "200", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.marker_removed, false);
  assert.ok(find("DELETE", /^\/v1\/pages\/42\/comments\/200$/));
  assert.equal(find("POST", /^\/v1\/pages\/42\?/), undefined);
});

test("page comment delete --dry-run sends nothing", async () => {
  seen = [];
  const r = await run(["page", "comment", "delete", "team/inline", "100", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dry_run, true);
  assert.deepEqual(j.marker, { start: 3, end: 19, text: "фрагмент" });
  assert.equal(seen.filter((s) => s.method === "DELETE").length, 0);
});

test("page locate lists ranges and flags marker overlap", async () => {
  const r = await run(["page", "locate", "team/reg", "абзац"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.query, "абзац");
  assert.equal(j.count, 2);
  assert.deepEqual(
    j.occurrences.map((o) => ({ start: o.start, end: o.end, line: o.line, column: o.column, inside: o.inside_marker })),
    [
      { start: 7, end: 12, line: 1, column: 8, inside: false },
      { start: 21, end: 26, line: 1, column: 22, inside: false },
    ],
  );

  const inline = await run(["page", "locate", "team/inline", "фрагмент"]);
  const ij = JSON.parse(inline.stdout);
  assert.equal(ij.count, 1);
  assert.equal(ij.occurrences[0].inside_marker, true);
});

test("page comments remains an alias for the list", async () => {
  const r = await run(["page", "comments", "team/reg"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).results.length, 2);
});

test("page comments add is rejected with a hint to page comment add", async () => {
  const r = await run(["page", "comments", "add", "team/reg", "x"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /page comment add/);
});

test("page comment add requires a body", async () => {
  const r = await run(["page", "comment", "add", "team/reg"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /источник|контент|body|текст/i);
});

test("page comment reply requires a thread id", async () => {
  const r = await run(["page", "comment", "reply", "team/reg"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /thread/i);
});

test("page comment delete requires a comment id", async () => {
  const r = await run(["page", "comment", "delete", "team/reg"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /id/i);
});
