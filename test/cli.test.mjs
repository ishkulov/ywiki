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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ywiki.mjs");
const YC = join(HERE, "fixtures", "stub-yc.mjs");

const IAM_PREFIX = ["t", "1", "."].join("");
const IAM = IAM_PREFIX + "B".repeat(40);
const STUB_TOKEN = IAM_PREFIX + "A".repeat(40);

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
      if (req.method === "GET" && /^\/v1\/pages\/\d+\/comments$/.test(url.pathname)) {
        const pid = url.pathname.split("/")[3];
        if (pid === "7") return send(200, { results: [], next_cursor: null, prev_cursor: null });
        if (url.searchParams.get("cursor") === "c2") {
          return send(200, { results: [{ id: 12, body: "Второй", author: { username: "bob" }, created_at: "2026-01-02T00:00:00Z", resolve_status: "resolved", thread_info: { total_posts: 0 } }], next_cursor: null, prev_cursor: "c1" });
        }
        return send(200, {
          results: [
            { id: 11, body: "Первый", author: { username: "alice" }, created_at: "2026-01-01T00:00:00Z", resolve_status: "unresolved", thread_info: { total_posts: 3 } },
            { id: 10, body: "Старый", author: { username: "carol" }, created_at: "2025-12-31T00:00:00Z", resolve_status: "resolved", thread_info: { total_posts: 0 } },
          ],
          next_cursor: "c2",
          prev_cursor: null,
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/users/me") {
        return send(200, { username: "alice", display_name: "Alice" });
      }
      if (req.method === "GET" && url.pathname === "/v1/pages") {
        const slug = url.searchParams.get("slug");
        if (slug === "no-comments") return send(200, { id: 7, slug, title: "Без комментов", page_type: "wysiwyg", content: "" });
        if (slug === "empty") return send(200, { id: 9, slug, title: "Пустая", page_type: "wysiwyg", content: "", attributes: { modified_at: "2026-01-01T00:00:00Z" } });
        return send(200, { id: 42, slug, title: "Заголовок", page_type: "wysiwyg", content: "X".repeat(20000), attributes: { modified_at: "2026-01-01T00:00:00Z" } });
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
  if (!("WIKI_CREDENTIALS" in extraEnv)) delete env.WIKI_CREDENTIALS;
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

test("page comments resolves the id and pipes JSON by default", async () => {
  const r = await run(["page", "comments", "team/reg"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.slug, "team/reg");
  assert.equal(j.id, 42);
  assert.equal(j.results.length, 2);
  assert.deepEqual(j.results[0], {
    id: 11,
    body: "Первый",
    inline_text: null,
    parent_id: null,
    thread_id: 11,
    author: "alice",
    created_at: "2026-01-01T00:00:00Z",
    resolve_status: "unresolved",
    reply_count: 3,
    is_deleted: false,
  });
  assert.equal(j.next_cursor, "c2");
});

test("page comments calls the by-id endpoint with page_size", async () => {
  seen = [];
  await run(["page", "comments", "team/reg", "--limit", "5"]);
  const comments = seen.find((s) => /\/comments/.test(s.url));
  assert.ok(comments, "must call the comments endpoint");
  assert.match(comments.url, /^\/v1\/pages\/42\/comments\?/);
  assert.match(comments.url, /page_size=5/);
});

test("page comments --all follows the string cursor", async () => {
  const r = await run(["page", "comments", "team/reg", "--all"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.results.length, 3);
  assert.equal(j.results[2].id, 12);
  assert.equal(j.next_cursor, null);
});

test("page comments rich output and empty hint", async () => {
  const rich = await run(["page", "comments", "team/reg", "--rich-ui=yes"]);
  assert.equal(rich.status, 0, rich.stderr);
  assert.match(rich.stdout, /#11 alice .*\[unresolved\] \(\+3 ответов\)/);
  assert.match(rich.stdout, /Первый/);

  const none = await run(["page", "comments", "no-comments", "--rich-ui=yes"]);
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /Комментариев нет/);
  assert.deepEqual(JSON.parse((await run(["page", "comments", "no-comments"])).stdout).results, []);
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
  for (const args of [["whoami"], ["get", "team/reg"], ["search", "x"], ["tree", ""], ["spaces"], ["page", "comments", "team/reg"]]) {
    const r = await run(args);
    assert.ok(!r.stdout.includes(IAM), `stdout leaked token for ${args.join(" ")}`);
    assert.ok(!r.stderr.includes(IAM), `stderr leaked token for ${args.join(" ")}`);
  }
});

test("auth login --method iam stores a credential; status and logout work offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ywiki-auth-cli-"));
  const cred = join(dir, "credentials.toml");
  const noEnv = { WIKI_IAM_TOKEN: "", WIKI_TOKEN: "", WIKI_CREDENTIALS: cred };
  try {
    const login = await run(
      ["auth", "login", "--method", "iam", "--organization-id", "orgTEST", "--yc-bin", YC],
      { ...noEnv, STUB_YC_TOKEN: STUB_TOKEN, STUB_YC_HANG: "", STUB_YC_FAIL: "" },
    );
    assert.equal(login.status, 0, login.stderr);
    const payload = JSON.parse(login.stdout);
    assert.equal(payload.authenticated, true);
    assert.equal(payload.scheme, "iam");
    assert.equal(payload.organization, "orgTEST");
    assert.ok(!login.stdout.includes(STUB_TOKEN), "login must not print the token");

    const text = readFileSync(cred, "utf8");
    assert.match(text, /version = 2/);
    assert.match(text, /scheme = "iam"/);
    assert.ok(text.includes(STUB_TOKEN), "credential file stores the token");

    const st = await run(["auth", "status", "--json"], noEnv);
    assert.equal(st.status, 0, st.stderr);
    const s = JSON.parse(st.stdout);
    assert.equal(s.present, true);
    assert.equal(s.source, "file");
    assert.equal(s.scheme, "iam");
    assert.equal(s.org, "orgTEST");
    assert.ok(!st.stdout.includes(STUB_TOKEN), "status must not print the token");

    const lo = await run(["auth", "logout", "--yes", "--json"], noEnv);
    assert.equal(lo.status, 0, lo.stderr);
    assert.equal(JSON.parse(lo.stdout).removed, true);
    assert.ok(!existsSync(cred), "logout removes the credential file");

    const st2 = await run(["auth", "status", "--json"], noEnv);
    assert.equal(st2.status, 0, st2.stderr);
    assert.equal(JSON.parse(st2.stdout).present, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth login without an organization id needs a flag or env (non-interactive exits 2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ywiki-auth-cli-"));
  const cred = join(dir, "credentials.toml");
  try {
    const r = await run(["auth", "login", "--method", "iam", "--yc-bin", YC], {
      WIKI_IAM_TOKEN: "",
      WIKI_TOKEN: "",
      WIKI_ORGANIZATION_ID: "",
      WIKI_CREDENTIALS: cred,
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /organization id/);
    assert.ok(!existsSync(cred), "no credential file is written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth login --method browser without a client id fails before any OAuth flow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ywiki-auth-cli-"));
  const cred = join(dir, "credentials.toml");
  try {
    const r = await run(["auth", "login", "--method", "browser", "--organization-id", "orgTEST"], {
      WIKI_IAM_TOKEN: "",
      WIKI_TOKEN: "",
      WIKI_OAUTH_CLIENT_ID: "",
      WIKI_CREDENTIALS: cred,
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /client id/);
    assert.ok(!existsSync(cred), "no credential file is written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth login refuses to write while an ENV token is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ywiki-auth-cli-"));
  const cred = join(dir, "credentials.toml");
  try {
    const r = await run(
      ["auth", "login", "--method", "iam", "--organization-id", "orgTEST", "--yc-bin", YC],
      { WIKI_CREDENTIALS: cred },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /снимите переменную/);
    assert.ok(!existsSync(cred), "no credential file is written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth login without --method needs a TTY (non-interactive exits 2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ywiki-auth-cli-"));
  const cred = join(dir, "credentials.toml");
  try {
    const r = await run(["auth", "login", "--organization-id", "orgTEST"], {
      WIKI_IAM_TOKEN: "",
      WIKI_TOKEN: "",
      WIKI_CREDENTIALS: cred,
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /укажите --method/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth logout without --yes needs a TTY and keeps the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ywiki-auth-cli-"));
  const cred = join(dir, "credentials.toml");
  const noEnv = { WIKI_IAM_TOKEN: "", WIKI_TOKEN: "", WIKI_CREDENTIALS: cred };
  try {
    const login = await run(
      ["auth", "login", "--method", "iam", "--organization-id", "orgTEST", "--yc-bin", YC],
      { ...noEnv, STUB_YC_TOKEN: STUB_TOKEN, STUB_YC_HANG: "", STUB_YC_FAIL: "" },
    );
    assert.equal(login.status, 0, login.stderr);
    assert.ok(existsSync(cred));

    const r = await run(["auth", "logout"], noEnv);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /нужно --yes/);
    assert.ok(existsSync(cred), "credential is kept without confirmation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
