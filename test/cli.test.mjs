// ywiki/tests/cli.test.mjs
// T3 tests: end-to-end CLI behaviour against a local stub HTTP server.
// No real network. Credentials come from ENV; the cache is a tmp dir.
//
// The stub runs in-process, so children are spawned ASYNC (execFile) to keep
// the event loop free to answer them.

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
const IAM = IAM_PREFIX + "B".repeat(40);

/** @type {import("node:http").Server} */
let server;
let baseUrl;
let cacheDir;
/** @type {Array<{method:string,url:string}>} */
let seen = [];

before(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "ywiki-t3-cache-"));
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    seen.push({ method: req.method, url: req.url });
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && url.pathname === "/v1/search") {
        const q = JSON.parse(body || "{}").query;
        if (q === "none") return send(200, { results: [], next_cursor: null });
        return send(200, { results: [{ slug: "team/reg", title: "Регламент" }, { slug: "other", title: "Другое" }], next_cursor: null });
      }
      if (req.method === "GET" && url.pathname === "/v1/spaces") {
        return send(200, { results: [{ slug: "project-x", title: "Project X" }], next_cursor: null });
      }
      if (req.method === "GET" && url.pathname === "/v1/pages/descendants") {
        return send(200, { results: [{ id: 1, slug: "team" }, { id: 2, slug: "team/sub" }], next_cursor: null });
      }
      if (req.method === "GET" && url.pathname === "/v1/pages") {
        const slug = url.searchParams.get("slug");
        if (slug === "empty") return send(200, { slug, title: "Пустая", page_type: "wysiwyg", content: "", attributes: { modified_at: "2026-01-01T00:00:00Z" } });
        return send(200, { slug, title: "Заголовок", page_type: "wysiwyg", content: "X".repeat(20000), attributes: { modified_at: "2026-01-01T00:00:00Z" } });
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

test("search pipes JSON by default; rich text with --rich-ui=yes", async () => {
  const j = await run(["search", "регламент"]);
  assert.equal(j.status, 0, j.stderr);
  assert.equal(j.stdout.trim(), JSON.stringify({ query: "регламент", results: [{ slug: "team/reg", title: "Регламент" }, { slug: "other", title: "Другое" }], next_cursor: null }, null, 2));

  const t = await run(["search", "регламент", "--rich-ui=yes"]);
  assert.equal(t.status, 0, t.stderr);
  assert.equal(t.stdout.trim(), "team/reg — Регламент\nother — Другое");
});

test("search uses POST with the page filter", async () => {
  seen = [];
  await run(["search", "x"]);
  const post = seen.find((s) => s.method === "POST");
  assert.ok(post, "search must POST");
  assert.match(post.url, /^\/v1\/search/);
});

test("empty search gives a hint (rich) and exits 0", async () => {
  const r = await run(["search", "none", "--rich-ui=yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Ничего не найдено/);
  assert.match(r.stdout, /Подсказка/);
  assert.equal(JSON.parse((await run(["search", "none"])).stdout).results.length, 0);
});

test("spaces prints 'slug — title' (rich); grouped `space list` matches", async () => {
  const r = await run(["spaces", "--rich-ui=yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "project-x — Project X");
  const g = await run(["space", "list", "--rich-ui=yes"]);
  assert.equal(g.stdout.trim(), "project-x — Project X");
});

test("tree lists descendant slugs; grouped `page descendants` matches", async () => {
  const r = await run(["tree", "", "--rich-ui=yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "team\nteam/sub");
  const g = await run(["page", "descendants", "", "--rich-ui=yes"]);
  assert.equal(g.stdout.trim(), "team\nteam/sub");
});

test("get clips long content and hints --offset", async () => {
  const r = await run(["get", "team/reg", "--limit", "100", "--rich-ui=yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--offset 100/);
  assert.ok(r.stdout.includes("X".repeat(100)));
});

test("get on an empty page prints EMPTY and exits 0", async () => {
  const r = await run(["get", "empty", "--rich-ui=yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /EMPTY/);
});

test("api GET is read-only and restricted to the confirmed surface", async () => {
  const ok = await run(["api", "GET", "spaces"]);
  assert.equal(ok.status, 0, ok.stderr);
  const bad = await run(["api", "POST", "pages"]);
  assert.equal(bad.status, 2);
  const off = await run(["api", "GET", "totally/bogus"]);
  assert.equal(off.status, 2);
});

test("skill prints bundled agent guidance", async () => {
  const r = await run(["skill"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /name: ywiki-cli/);
  assert.match(r.stdout, /do not retry/);
});

test("unknown command exits 2 with the error envelope and usage", async () => {
  const r = await run(["frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^Error: Invalid command usage/);
  assert.match(r.stderr, /Next:/);
  assert.match(r.stderr, /Usage/);
});

test("--help exits 0 and is at most 25 lines", async () => {
  const r = await run(["--help"]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.trimEnd().split("\n").length <= 25);
});

test("--version and -v print the version; -v --json is machine-readable", async () => {
  const long = await run(["--version"]);
  assert.equal(long.status, 0);
  assert.match(long.stdout, /^ywiki \d+\.\d+\.\d+/);

  const short = await run(["-v"]);
  assert.equal(short.status, 0, short.stderr);
  assert.equal(short.stdout.trim(), long.stdout.trim());

  const j = await run(["-v", "--json"]);
  assert.equal(j.status, 0, j.stderr);
  assert.deepEqual(Object.keys(JSON.parse(j.stdout)).sort(), ["contour", "version"]);
});

test("no output ever contains the full token", async () => {
  for (const args of [["whoami"], ["get", "team/reg"], ["search", "x"], ["tree", ""], ["spaces"]]) {
    const r = await run(args);
    assert.ok(!r.stdout.includes(IAM), `stdout leaked token for ${args.join(" ")}`);
    assert.ok(!r.stderr.includes(IAM), `stderr leaked token for ${args.join(" ")}`);
  }
});
