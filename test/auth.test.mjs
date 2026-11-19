// ywiki/tests/auth.test.mjs
// login/logout/status and token validation. Wiki is stubbed through fetchImpl;
// the real credential file is never touched and no network call is made.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  loginWithIam,
  loginWithToken,
  logout,
  organizationKind,
  readSecret,
  status,
  tokenPageUrl,
} from "../lib/auth.mjs";
import { AuthError, invalidate, readCredentialFile, writeCredential } from "../lib/credentials.mjs";

const IAM_PREFIX = ["t", "1", "."].join("");
const iam = (body = "A".repeat(40)) => IAM_PREFIX + body;
const oauth = (body = "B".repeat(40)) => ["y", "0", "_"].join("") + body;

const ENV_KEYS = [
  "WIKI_CREDENTIALS",
  "WIKI_CACHE_DIR",
  "WIKI_IAM_TOKEN",
  "WIKI_TOKEN",
  "WIKI_ORGANIZATION_ID",
  "WIKI_BASE_URL",
];

/** @type {Record<string, string | undefined>} */
const saved = {};
/** @type {string} */
let dir;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  invalidate();
  dir = mkdtempSync(join(tmpdir(), "ywiki-auth-"));
  process.env.WIKI_CREDENTIALS = join(dir, "credentials.toml");
  process.env.WIKI_CACHE_DIR = dir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  invalidate();
  rmSync(dir, { recursive: true, force: true });
});

/** @param {any} [identity] */
function okFetch(identity = { username: "alice", display_name: "Alice" }) {
  /** @type {Array<{ url: string, headers: Record<string, string> }>} */
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify(identity), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

test("loginWithToken validates an IAM token and stores the credential", async () => {
  const token = iam();
  const { fetchImpl, calls } = okFetch();

  const result = await loginWithToken({
    token,
    org: "b1g1234567890abcdef",
    scheme: "iam",
    baseUrl: "http://stub.test",
    fetchImpl,
  });

  assert.equal(result.creds.scheme, "iam");
  assert.equal(result.creds.token, token);
  assert.equal(result.path, process.env.WIKI_CREDENTIALS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://stub.test/users/me");
  assert.equal(calls[0].headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].headers["X-Cloud-Org-Id"], "b1g1234567890abcdef");

  const stored = readCredentialFile();
  assert.equal(stored?.token, token);
  assert.equal(stored?.scheme, "iam");
});

test("loginWithToken rejects a token Wiki does not accept and stores nothing", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error_code: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    () =>
      loginWithToken({
        token: iam(),
        org: "b1g123",
        scheme: "iam",
        baseUrl: "http://stub.test",
        fetchImpl,
      }),
    (e) => e && e.kind === "unauthenticated",
  );
  assert.equal(readCredentialFile(), null);
});

test("loginWithIam runs yc and stores the resulting IAM token", async () => {
  const token = iam("B".repeat(40));
  const { fetchImpl } = okFetch();

  const result = await loginWithIam({
    org: "b1g123",
    baseUrl: "http://stub.test",
    fetchImpl,
    run: async () => ({ stdout: `${token}\n`, stderr: "" }),
  });

  assert.equal(result.creds.scheme, "iam");
  assert.equal(result.creds.token, token);
  assert.equal(readCredentialFile()?.token, token);
});

test("logout removes the local credential and is idempotent", () => {
  writeCredential({ token: iam(), scheme: "iam", org: "b1g123", mtimeMs: 0 });

  const first = logout();
  assert.equal(first.removed, true);
  assert.equal(readCredentialFile(), null);

  const second = logout();
  assert.equal(second.removed, false);
});

test("logout refuses to manage the file while an ENV token is active", () => {
  process.env.WIKI_IAM_TOKEN = iam();
  process.env.WIKI_ORGANIZATION_ID = "b1g123";
  assert.throws(() => logout(), /снимите переменную/);
});

test("status reports the file credential without a network call", () => {
  writeCredential({
    token: iam(),
    scheme: "iam",
    org: "b1g123",
    mtimeMs: 0,
    refreshToken: "refresh-secret",
    clientId: "client-id",
  });

  const s = status();
  assert.equal(s.present, true);
  assert.equal(s.source, "file");
  assert.equal(s.scheme, "iam");
  assert.equal(s.org, "b1g123");
  assert.equal(s.organizationKind, "cloud");
  assert.match(s.tokenPrefix, /^t1\./);
  assert.equal(s.hasRefreshToken, true);
});

test("status reports an ENV credential as source=env", () => {
  process.env.WIKI_TOKEN = oauth();
  process.env.WIKI_ORGANIZATION_ID = "12345";

  const s = status();
  assert.equal(s.present, true);
  assert.equal(s.source, "env");
  assert.equal(s.scheme, "oauth");
  assert.equal(s.organizationKind, "yandex360");
  assert.equal(s.path, null);
});

test("status reports an absent credential", () => {
  const s = status();
  assert.equal(s.present, false);
  assert.equal(s.source, "none");
  assert.equal(s.path, process.env.WIKI_CREDENTIALS);
});

test("readSecret reads the first non-empty line from stdin", async () => {
  const token = iam();
  const secret = await readSecret({
    input: Readable.from([`  ${token}\n`]),
    noInput: true,
  });
  assert.equal(secret, token);
});

test("readSecret rejects empty input", async () => {
  await assert.rejects(
    () => readSecret({ input: Readable.from(["\n\n"]), noInput: true }),
    (e) => e instanceof AuthError && e.kind === "unauthenticated",
  );
});

test("tokenPageUrl is empty without a client id and points at the token page with one", () => {
  assert.equal(tokenPageUrl({}), "");
  const url = new URL(tokenPageUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:43110/callback" }));
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:43110/callback");
});

test("organizationKind separates Yandex 360 from cloud", () => {
  assert.equal(organizationKind("12345"), "yandex360");
  assert.equal(organizationKind("b1g123"), "cloud");
});
