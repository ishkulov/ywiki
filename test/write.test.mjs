// ywiki/tests/write.test.mjs
// End-to-end tests for the mutating commands (`page create|edit|append|delete`).
// A local stub server records method/path/body; no real network. Credentials
// come from ENV and the cache is a tmp dir.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ywiki.mjs");

const IAM_PREFIX = ["t", "1", "."].join("");
const IAM = IAM_PREFIX + "C".repeat(40);

/** @type {import("node:http").Server} */
let server;
let baseUrl;
let cacheDir;
/** @type {Array<{method:string, url:string, body:any}>} */
let seen = [];

const PAGES = {
  "team/reg": { id: 42, title: "Регламент", page_type: "wysiwyg", content: "старый текст", last_revision_id: 5 },
  "team/readonly": { id: 43, title: "Только чтение", page_type: "wysiwyg", content: "x", attributes: { is_readonly: true } },
  "team/grid": { id: 44, title: "Таблица", page_type: "grid", content: "x" },
};

before(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "ywiki-write-cache-"));
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
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
        return send(200, { ...page, slug, attributes: { modified_at: "2026-01-01T00:00:00Z", ...(page.attributes || {}) } });
      }
      if (req.method === "POST" && url.pathname === "/v1/pages") {
        if (body?.title === "conflict") return send(409, { error_code: "CONFLICT" });
        if (body?.title === "invalid") return send(400, { error_code: "VALIDATION_ERROR", debug_message: "slug is invalid" });
        return send(200, { id: 77, slug: body?.slug, title: body?.title, last_revision_id: 1, attributes: { modified_at: "2026-01-01T00:00:00Z" } });
      }
      if (req.method === "POST" && /^\/v1\/pages\/\d+$/.test(url.pathname)) {
        if (body?.revision === "conflict") return send(409, { error_code: "CONFLICT" });
        const id = Number(url.pathname.split("/")[3]);
        return send(200, { id, slug: "team/reg", title: body?.title ?? "Регламент", last_revision_id: 6, attributes: { modified_at: "2026-01-02T00:00:00Z" } });
      }
      if (req.method === "POST" && /^\/v1\/pages\/\d+\/append-content$/.test(url.pathname)) {
        const id = Number(url.pathname.split("/")[3]);
        return send(200, { id, slug: "team/reg", title: "Регламент", last_revision_id: 7, attributes: { modified_at: "2026-01-03T00:00:00Z" } });
      }
      if (req.method === "DELETE" && /^\/v1\/pages\/\d+$/.test(url.pathname)) {
        return send(200, { recovery_token: "11111111-2222-3333-4444-555555555555" });
      }
      return send(404, { error_code: "NOT_FOUND" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => {
  server.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

/**
 * @param {string[]} args
 * @param {Record<string,string>} [extraEnv]
 * @returns {Promise<{status:number, stdout:string, stderr:string}>}
 */
function run(args, extraEnv = {}) {
  const env = {
    ...process.env,
    WIKI_BASE_URL: baseUrl,
    WIKI_IAM_TOKEN: IAM,
    WIKI_ORGANIZATION_ID: "orgTEST",
    WIKI_CACHE_DIR: cacheDir,
    ...extraEnv,
  };
  delete env.LEGACY_CREDENTIALS;
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { encoding: "utf8", env }, (err, stdout, stderr) => {
      resolve({ status: err && typeof err.code === "number" ? err.code : 0, stdout, stderr });
    });
  });
}

/** @param {string} method @param {RegExp} re */
function find(method, re) {
  return seen.find((s) => s.method === method && re.test(s.url));
}

// --- create ----------------------------------------------------------------

test("page create posts slug/title/content and prints JSON", async () => {
  seen = [];
  const r = await run(["page", "create", "team/new", "--title", "Новая", "--content", "текст"]);
  assert.equal(r.status, 0, r.stderr);
  const post = find("POST", /^\/v1\/pages\?/);
  assert.ok(post, "must POST /v1/pages");
  assert.deepEqual(post.body, { slug: "team/new", title: "Новая", content: "текст" });
  const j = JSON.parse(r.stdout);
  assert.equal(j.id, 77);
  assert.equal(j.slug, "team/new");
  assert.equal(j.last_revision_id, 1);
});

test("page create requires --title", async () => {
  seen = [];
  const r = await run(["page", "create", "team/new", "--content", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--title/);
  assert.equal(find("POST", /^\/v1\/pages/), undefined);
});

test("page create --dry-run sends nothing", async () => {
  seen = [];
  const r = await run(["page", "create", "team/new", "--title", "Новая", "--content", "x", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dry_run, true);
  assert.equal(j.action, "create");
  assert.equal(find("POST", /^\/v1\/pages/), undefined);
});

// --- edit ------------------------------------------------------------------

test("page edit sends content with the current revision as a string", async () => {
  seen = [];
  const r = await run(["page", "edit", "team/reg", "--content", "новый текст"]);
  assert.equal(r.status, 0, r.stderr);
  const post = find("POST", /^\/v1\/pages\/42\?/);
  assert.ok(post, "must POST /v1/pages/42");
  assert.deepEqual(post.body, { content: "новый текст", revision: "5" });
  const j = JSON.parse(r.stdout);
  assert.equal(j.revision_before, "5");
  assert.equal(j.last_revision_id, 6);
  assert.equal(j.changed, true);
});

test("page edit --force omits revision", async () => {
  seen = [];
  const r = await run(["page", "edit", "team/reg", "--content", "x", "--force"]);
  assert.equal(r.status, 0, r.stderr);
  const post = find("POST", /^\/v1\/pages\/42\?/);
  assert.deepEqual(post.body, { content: "x" });
});

test("page edit --force conflicts with --if-revision", async () => {
  const r = await run(["page", "edit", "team/reg", "--content", "x", "--force", "--if-revision", "3"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /взаимоисключающие/);
});

test("page edit --if-revision overrides the read revision", async () => {
  seen = [];
  const r = await run(["page", "edit", "team/reg", "--content", "x", "--if-revision", "4"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(find("POST", /^\/v1\/pages\/42\?/).body, { content: "x", revision: "4" });
});

test("page edit --dry-run reports a diff and sends nothing", async () => {
  seen = [];
  const r = await run(["page", "edit", "team/reg", "--content", "новый текст", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dry_run, true);
  assert.equal(j.changed, true);
  assert.equal(j.revision, "5");
  assert.equal(j.bytes_before, Buffer.byteLength("старый текст"));
  assert.equal(find("POST", /^\/v1\/pages\/42/), undefined);
});

test("page edit refuses read-only pages with exit 4", async () => {
  const r = await run(["page", "edit", "team/readonly", "--content", "x"]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /только для чтения/);
});

test("page edit refuses content edits on grid pages with exit 2", async () => {
  const r = await run(["page", "edit", "team/grid", "--content", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /grid/);
});

test("page edit needs a content source or a title", async () => {
  const r = await run(["page", "edit", "team/reg"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--file/);
});

test("page edit rejects two content sources", async () => {
  const r = await run(["page", "edit", "team/reg", "--content", "a", "--stdin"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ровно один источник/);
});

test("page edit surfaces a 409 as conflict (exit 6)", async () => {
  const r = await run(["page", "edit", "team/reg", "--content", "x", "--if-revision", "conflict"]);
  assert.equal(r.status, 6, r.stderr);
  assert.match(r.stderr, /Conflict/);
});

// --- append ----------------------------------------------------------------

test("page append defaults to the bottom of the page", async () => {
  seen = [];
  const r = await run(["page", "append", "team/reg", "--content", "доп"]);
  assert.equal(r.status, 0, r.stderr);
  const post = find("POST", /\/append-content\?/);
  assert.deepEqual(post.body, { content: "доп", revision: "5", body: { location: "bottom" } });
  assert.equal(JSON.parse(r.stdout).last_revision_id, 7);
});

test("page append --at top changes the location", async () => {
  seen = [];
  await run(["page", "append", "team/reg", "--content", "x", "--at", "top"]);
  assert.deepEqual(find("POST", /\/append-content\?/).body.body, { location: "top" });
});

test("page append --section and --anchor are mutually exclusive", async () => {
  const r = await run(["page", "append", "team/reg", "--content", "x", "--section", "3", "--anchor", "Итог"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /взаимоисключающие/);
});

test("page append --anchor builds the anchor object", async () => {
  seen = [];
  await run(["page", "append", "team/reg", "--content", "x", "--anchor", "Итог", "--anchor-regex", "--anchor-fallback"]);
  assert.deepEqual(find("POST", /\/append-content\?/).body.anchor, { name: "Итог", fallback: true, regex: true });
});

test("page append requires content", async () => {
  const r = await run(["page", "append", "team/reg"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /контент/);
});

// --- delete ----------------------------------------------------------------

test("page delete without --yes and without a TTY exits 2", async () => {
  seen = [];
  const r = await run(["page", "delete", "team/reg"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--yes/);
  assert.equal(find("DELETE", /^\/v1\/pages/), undefined);
});

test("page delete --yes deletes and prints the recovery token", async () => {
  seen = [];
  const r = await run(["page", "delete", "team/reg", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  const del = find("DELETE", /^\/v1\/pages\/42$/);
  assert.ok(del, "must DELETE /v1/pages/42");
  const j = JSON.parse(r.stdout);
  assert.equal(j.id, 42);
  assert.equal(j.recovery_token, "11111111-2222-3333-4444-555555555555");
});

test("page delete --recursive adds recursive=true", async () => {
  seen = [];
  await run(["page", "delete", "team/reg", "--yes", "--recursive"]);
  assert.ok(find("DELETE", /^\/v1\/pages\/42\?recursive=true$/));
});

test("page delete --dry-run sends nothing", async () => {
  seen = [];
  const r = await run(["page", "delete", "team/reg", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).dry_run, true);
  assert.equal(find("DELETE", /^\/v1\/pages/), undefined);
});

// --- discovery / guards ----------------------------------------------------

test("`page write` is rejected and points at the real verbs", async () => {
  const r = await run(["page", "write", "team/reg", "--content", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /create\|edit\|append\|delete/);
});

test("`ywiki write` is rejected as an unknown command", async () => {
  const r = await run(["write", "edit", "team/reg"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /неизвестная команда/);
});

test("page edit --help prints the command help", async () => {
  const r = await run(["page", "edit", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ywiki page edit/);
  assert.match(r.stdout, /no \$EDITOR/);
});

test("write commands never print the full token", async () => {
  const r = await run(["page", "edit", "team/reg", "--content", "x"]);
  assert.ok(!r.stdout.includes(IAM));
  assert.ok(!r.stderr.includes(IAM));
});
