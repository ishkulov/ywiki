// ywiki/tests/client.test.mjs
// T2 tests: HTTP client behaviour with an injected fetch. No real network.
// Cache is isolated to a tmp dir via the cacheDir option; credentials use ENV.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, buildQuery } from "../lib/client.mjs";
import { WikiError } from "../lib/output.mjs";
import { invalidate } from "../lib/credentials.mjs";

const IAM_PREFIX = ["t", "1", "."].join("");
const IAM = IAM_PREFIX + "A".repeat(40);

const ENV_KEYS = ["WIKI_IAM_TOKEN", "WIKI_ORGANIZATION_ID", "WIKI_CACHE_DIR", "WIKI_NO_CACHE"];
/** @type {Record<string, string | undefined>} */
const saved = {};
/** @type {string} */
let dir;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.WIKI_IAM_TOKEN = IAM;
  process.env.WIKI_ORGANIZATION_ID = "orgTEST";
  delete process.env.WIKI_CACHE_DIR;
  delete process.env.WIKI_NO_CACHE;
  dir = mkdtempSync(join(tmpdir(), "ywiki-t2-"));
  invalidate();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  invalidate();
  rmSync(dir, { recursive: true, force: true });
});

/** @param {Array<{status?: number, body?: string} | Error>} script */
function fetchScript(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = script.shift();
    if (step instanceof Error) throw step;
    const { status = 200, body = "{}" } = step || {};
    return { status, text: async () => body };
  };
  return { impl, calls };
}

function client(script, extra = {}) {
  const { impl, calls } = fetchScript(script);
  return { c: createClient({ fetchImpl: impl, cacheDir: dir, sleepFn: async () => {}, ...extra }), calls };
}

async function capture(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a throw");
}

test("200 returns parsed JSON and sends auth + org headers", async () => {
  const { c, calls } = client([{ status: 200, body: '{"ok":true}' }]);
  const out = await c.request("/users/me");
  assert.deepEqual(out, { ok: true });
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${IAM}`);
  assert.equal(calls[0].init.headers["X-Cloud-Org-Id"], "orgTEST");
});

test("404 maps to not_found", async () => {
  const { c } = client([{ status: 404, body: '{"error_code":"NOT_FOUND"}' }]);
  const e = await capture(() => c.request("/pages?slug=x"));
  assert.ok(e instanceof WikiError);
  assert.equal(e.kind, "not_found");
});

test("403 maps to access_denied and is not retried", async () => {
  const { c, calls } = client([
    { status: 403 },
    { status: 403 },
    { status: 403 },
    { status: 403 },
  ]);
  const e = await capture(() => c.request("/pages?slug=secret"));
  assert.equal(e.kind, "access_denied");
  assert.equal(calls.length, 1, "no retries on 403");
});

test("409 maps to conflict (no retry)", async () => {
  const { c, calls } = client([{ status: 409 }]);
  const e = await capture(() => c.request("/pages?slug=x"));
  assert.equal(e.kind, "conflict");
  assert.equal(calls.length, 1);
});

test("400 ALREADY_INDEXING maps to conflict", async () => {
  const { c } = client([{ status: 400, body: '{"error_code":"ALREADY_INDEXING"}' }]);
  const e = await capture(() => c.request("/search", { method: "POST", body: { query: "x" } }));
  assert.equal(e.kind, "conflict");
});

test("429 is retried up to 3 attempts then unavailable", async () => {
  const { c, calls } = client([{ status: 429 }, { status: 429 }, { status: 429 }]);
  const e = await capture(() => c.request("/pages?slug=x"));
  assert.equal(e.kind, "unavailable");
  assert.equal(calls.length, 3);
});

test("429 then 200 succeeds on retry", async () => {
  const { c, calls } = client([{ status: 429 }, { status: 200, body: '{"v":1}' }]);
  const out = await c.request("/pages?slug=x");
  assert.deepEqual(out, { v: 1 });
  assert.equal(calls.length, 2);
});

test("5xx is retried with backoff then fails", async () => {
  const delays = [];
  const { impl } = fetchScript([{ status: 503 }, { status: 500 }, { status: 502 }]);
  const c = createClient({ fetchImpl: impl, cacheDir: dir, sleepFn: async (ms) => delays.push(ms) });
  const e = await capture(() => c.request("/spaces"));
  assert.equal(e.kind, "unavailable");
  assert.deepEqual(delays, [500, 1000], "exponential backoff 500,1000");
});

test("timeout aborts and maps to unavailable", async () => {
  const impl = async (url, init) =>
    new Promise((_res, rej) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        rej(err);
      });
    });
  const c = createClient({ fetchImpl: impl, cacheDir: dir, timeoutMs: 20, sleepFn: async () => {} });
  const e = await capture(() => c.request("/spaces"));
  assert.equal(e.kind, "unavailable");
  assert.match(e.message, /таймаут/);
});

test("buildQuery encodes cyrillic and slashes", () => {
  assert.equal(buildQuery({ slug: "team/проект" }), `?slug=${encodeURIComponent("team/проект")}`);
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery({ a: 1, b: undefined }), "?a=1");
});

test("cache hit avoids a second network call; distinct keys differ", async () => {
  const { c, calls } = client([{ status: 200, body: '{"n":1}' }]);
  const a = await c.request("/pages?slug=x");
  const b = await c.request("/pages?slug=x");
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1, "second call served from cache");
  await c.request("/pages?slug=y");
  assert.equal(calls.length, 2, "different slug is a different key");
});

test("non-2xx responses are not cached", async () => {
  const { c, calls } = client([{ status: 404 }, { status: 200, body: '{"ok":1}' }]);
  await capture(() => c.request("/pages?slug=x"));
  await c.request("/pages?slug=x");
  assert.equal(calls.length, 2, "404 was not cached");
});

test("cache expires after TTL", async () => {
  let now = 1000;
  const { impl, calls } = fetchScript([{ status: 200, body: '{"n":1}' }, { status: 200, body: '{"n":2}' }]);
  const c = createClient({ fetchImpl: impl, cacheDir: dir, clock: () => now, sleepFn: async () => {} });
  await c.request("/pages?slug=x");
  now += 61000; // past 60s TTL
  const out = await c.request("/pages?slug=x");
  assert.deepEqual(out, { n: 2 });
  assert.equal(calls.length, 2);
});

test("cache directory stores no headers or tokens", async () => {
  const { c } = client([{ status: 200, body: '{"n":1}' }]);
  await c.request("/pages?slug=x");
  const { readdirSync, readFileSync } = await import("node:fs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 1);
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    assert.ok(!raw.includes(IAM), "token must not be in cache");
    assert.ok(!raw.toLowerCase().includes("authorization"), "headers must not be in cache");
  }
});

test("401 without refresh maps to unauthenticated (single attempt)", async () => {
  const { c, calls } = client([{ status: 401 }]);
  const e = await capture(() => c.request("/pages?slug=x"));
  assert.equal(e.kind, "unauthenticated");
  assert.equal(calls.length, 1);
});

test("401 with refresh self-heals once and retries the request", async () => {
  let refreshes = 0;
  const { impl, calls } = fetchScript([{ status: 401 }, { status: 200, body: '{"ok":1}' }]);
  const c = createClient({
    fetchImpl: impl,
    cacheDir: dir,
    sleepFn: async () => {},
    refresh: async () => {
      refreshes++;
    },
  });
  const out = await c.request("/pages?slug=x");
  assert.deepEqual(out, { ok: 1 });
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 2);
});

test("401 self-heal is not attempted for non-whitelisted endpoints", async () => {
  let refreshes = 0;
  const { c, calls } = client([{ status: 401 }], { refresh: async () => { refreshes++; } });
  const e = await capture(() => c.request("/other/thing"));
  assert.equal(e.kind, "unauthenticated");
  assert.equal(refreshes, 0);
  assert.equal(calls.length, 1);
});

test("refresh failure surfaces unauthenticated", async () => {
  const { c } = client([{ status: 401 }], {
    refresh: async () => {
      throw new WikiError("unauthenticated", "refresh failed");
    },
  });
  const e = await capture(() => c.request("/spaces"));
  assert.equal(e.kind, "unauthenticated");
});

// --- mutations -------------------------------------------------------------

test("a mutating request is never cached", async () => {
  const { c, calls } = client([
    { status: 200, body: '{"id":1}' },
    { status: 200, body: '{"id":2}' },
  ]);
  assert.deepEqual(await c.request("/pages/1", { method: "POST", body: { title: "a" } }), { id: 1 });
  assert.deepEqual(await c.request("/pages/1", { method: "POST", body: { title: "a" } }), { id: 2 });
  assert.equal(calls.length, 2);
});

test("a mutating request is not retried after 5xx", async () => {
  const { c, calls } = client([{ status: 503, body: '{"error_code":"UNAVAILABLE"}' }]);
  const e = await capture(() => c.request("/pages/1", { method: "POST", body: { title: "a" } }));
  assert.equal(e.kind, "unavailable");
  assert.match(e.message, /не повторяется/);
  assert.equal(calls.length, 1);
});

test("a mutating request is not retried after a network error", async () => {
  const { c, calls } = client([new Error("ECONNRESET")]);
  const e = await capture(() => c.request("/pages/1", { method: "DELETE" }));
  assert.equal(e.kind, "unavailable");
  assert.equal(calls.length, 1);
});

test("a successful write clears cached reads", async () => {
  const { c, calls } = client([
    { status: 200, body: '{"title":"before"}' },
    { status: 200, body: '{"id":1}' },
    { status: 200, body: '{"title":"after"}' },
  ]);
  assert.deepEqual(await c.request("/pages?slug=x"), { title: "before" });
  await c.request("/pages/1", { method: "POST", body: { title: "after" } });
  assert.deepEqual(await c.request("/pages?slug=x"), { title: "after" });
  assert.equal(calls.length, 3);
});

test("a 409 on a write maps to conflict", async () => {
  const { c } = client([{ status: 409, body: '{"error_code":"CONFLICT"}' }]);
  const e = await capture(() => c.request("/pages/1", { method: "POST", body: { revision: "1" } }));
  assert.equal(e.kind, "conflict");
});

test("a 400 VALIDATION_ERROR maps to usage with a redacted detail", async () => {
  const { c } = client([
    { status: 400, body: JSON.stringify({ error_code: "VALIDATION_ERROR", debug_message: "title must not be empty" }) },
  ]);
  const e = await capture(() => c.request("/pages/1", { method: "POST", body: {} }));
  assert.equal(e.kind, "usage");
  assert.match(e.message, /title must not be empty/);
});
