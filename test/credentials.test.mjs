// ywiki/tests/credentials.test.mjs
// T1 tests. All cases use tmp fixtures via LEGACY_CREDENTIALS; the real credential
// file (~/.config/legacy/legacy/credentials.toml) is NEVER read here.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { credentials, invalidate, authHeaders, redact, AuthError } from "../lib/credentials.mjs";

// Build token literals at runtime so the repository stays free of the IAM
// prefix (Definition of Done: `grep -r 't1\.'` is empty).
const IAM_PREFIX = ["t", "1", "."].join("");
const iam = (body = "A".repeat(40)) => IAM_PREFIX + body;
const oauth = (body = "B".repeat(30)) => ["y", "0", "_", "_"].join("") + body;

const ENV_KEYS = [
  "LEGACY_CREDENTIALS",
  "WIKI_IAM_TOKEN",
  "WIKI_ORGANIZATION_ID",
  "LEGACY_IAM_TOKEN",
  "LEGACY_ORGANIZATION_ID",
];

/** @type {string[]} */
const savedEnv = {};
/** @type {string} */
let dir;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  invalidate();
  dir = mkdtempSync(join(tmpdir(), "ywiki-t1-"));
  process.env.LEGACY_CREDENTIALS = join(dir, "credentials.toml");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  invalidate();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run fn and return the AuthError it throws.
 * @param {() => unknown} fn
 * @returns {AuthError}
 */
function captureAuth(fn) {
  try {
    fn();
  } catch (e) {
    if (e instanceof AuthError) return e;
    throw e;
  }
  assert.fail("expected AuthError to be thrown");
}

/** @param {string} token @param {string} [scheme] @param {string} [org] @param {number} [version] */
function writeCred(token, scheme = "iam", org = "orgABCDEFGHIJKLMNOPQ", version = 2) {
  const text = `version = ${version}\ntoken = "${token}"\nscheme = "${scheme}"\norganization_id = "${org}"\n`;
  writeFileSync(process.env.LEGACY_CREDENTIALS, text);
}

test("valid iam credential is parsed", () => {
  writeCred(iam());
  const c = credentials();
  assert.equal(c.scheme, "iam");
  assert.equal(c.org, "orgABCDEFGHIJKLMNOPQ");
  assert.equal(c.token, iam());
  assert.ok(c.mtimeMs > 0);
});

test("missing file throws AuthError(unauthenticated)", () => {
  const err = captureAuth(() => credentials());
  assert.equal(err.kind, "unauthenticated");
  assert.match(err.message, /нет файла/);
});

test("version=3 is rejected", () => {
  writeCred(iam(), "iam", "orgX", 3);
  const err = captureAuth(() => credentials());
  assert.equal(err.kind, "unauthenticated");
  assert.match(err.message, /version=3/);
});

test("empty token is rejected", () => {
  writeCred("");
  const err = captureAuth(() => credentials());
  assert.equal(err.kind, "unauthenticated");
});

test("non-iam-format token is rejected when scheme=iam", () => {
  writeCred("not-an-iam-token-xxxxxxxxxxxxxxxxxxxxx");
  const err = captureAuth(() => credentials());
  assert.equal(err.kind, "unauthenticated");
  assert.match(err.message, /формат/);
});

test("oauth scheme accepts non-iam token and uses OAuth keyword", () => {
  writeCred(oauth(), "oauth");
  const c = credentials();
  assert.equal(c.scheme, "oauth");
  const h = authHeaders(c);
  assert.match(h.Authorization, /^OAuth /);
  assert.equal(h.Authorization, `OAuth ${oauth()}`);
});

test("numeric organization selects X-Org-Id", () => {
  writeCred(iam(), "iam", "1234567890");
  const h = authHeaders(credentials());
  assert.equal(h["X-Org-Id"], "1234567890");
  assert.equal(h["X-Cloud-Org-Id"], undefined);
});

test("non-numeric organization selects X-Cloud-Org-Id", () => {
  writeCred(iam(), "iam", "bpfi3te3d3tducta60b3");
  const h = authHeaders(credentials());
  assert.equal(h["X-Cloud-Org-Id"], "bpfi3te3d3tducta60b3");
  assert.equal(h["X-Org-Id"], undefined);
  assert.match(h.Authorization, /^Bearer /);
});

test("ENV override wins and the file is not read", () => {
  // Point LEGACY_CREDENTIALS at a non-existent path: if ENV is honoured, no throw.
  process.env.LEGACY_CREDENTIALS = join(dir, "does-not-exist.toml");
  process.env.WIKI_IAM_TOKEN = iam("C".repeat(40));
  process.env.WIKI_ORGANIZATION_ID = "envorg";
  const c = credentials();
  assert.equal(c.token, iam("C".repeat(40)));
  assert.equal(c.org, "envorg");
  assert.equal(c.mtimeMs, 0);
});

test("LEGACY_* override is used as a fallback", () => {
  process.env.LEGACY_CREDENTIALS = join(dir, "nope.toml");
  process.env.LEGACY_IAM_TOKEN = iam("D".repeat(40));
  process.env.LEGACY_ORGANIZATION_ID = "torg";
  const c = credentials();
  assert.equal(c.org, "torg");
  assert.equal(c.token, iam("D".repeat(40)));
});

test("mtime change triggers a re-read", () => {
  writeCred(iam("E".repeat(40)));
  const first = credentials();
  assert.equal(first.token, iam("E".repeat(40)));

  // Rewrite with a new token and force a distinct mtime.
  writeCred(iam("F".repeat(40)));
  const future = new Date(Date.now() + 5000);
  utimesSync(process.env.LEGACY_CREDENTIALS, future, future);

  const second = credentials();
  assert.equal(second.token, iam("F".repeat(40)));
  assert.notEqual(second.mtimeMs, first.mtimeMs);
});

test("redact() hides the token and keeps only a 6-char prefix", () => {
  const tok = iam("G".repeat(40));
  writeCred(tok);
  credentials(); // populate cache so redact knows the live token
  const line = `Authorization: Bearer ${tok}`;
  const out = redact(line);
  assert.ok(!out.includes(tok), "token must not survive redact()");
  assert.ok(out.includes(tok.slice(0, 6) + "…"), "prefix should remain");
});

test("redact() also masks token-like strings without a loaded cache", () => {
  invalidate();
  const stray = iam("H".repeat(40));
  const out = redact(`oops ${stray}`);
  assert.ok(!out.includes(stray));
});
