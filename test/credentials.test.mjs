// ywiki/tests/credentials.test.mjs
// Credential parsing and storage. All cases use a tmp WIKI_CREDENTIALS path;
// the real credential file is never touched.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AuthError,
  authHeaders,
  credentialPath,
  credentials,
  envCredentials,
  invalidate,
  readCredentialFile,
  redact,
  removeCredential,
  validate,
  writeCredential,
} from "../lib/credentials.mjs";

const IAM_PREFIX = ["t1", "."].join("");
const iam = (body = "A".repeat(40)) => IAM_PREFIX + body;
const oauth = (body = "B".repeat(40)) => ["y", "oo", "ps"].join("") + body;

const ENV_KEYS = [
  "WIKI_CREDENTIALS",
  "WIKI_IAM_TOKEN",
  "WIKI_TOKEN",
  "WIKI_ORGANIZATION_ID",
  "LEGACY_IAM_TOKEN",
  "LEGACY_TOKEN",
  "LEGACY_ORGANIZATION_ID",
];

/** @type {string[]} */
const saved = {};
/** @type {string} */
let dir;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  invalidate();
  dir = mkdtempSync(join(tmpdir(), "ywiki-cred-"));
  process.env.WIKI_CREDENTIALS = join(dir, "credentials.toml");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  invalidate();
  rmSync(dir, { recursive: true, force: true });
});

/** @param {string} token @param {string} [scheme] @param {string} [org] */
function writeCred(token, scheme = "iam", org = "b1g1234567890abcdef") {
  writeFileSync(
    process.env.WIKI_CREDENTIALS,
    `version = 2\ntoken = "${token}"\nscheme = "${scheme}"\norganization_id = "${org}"\n`,
  );
}

test("default path is ~/.config/ywiki/credentials.toml", () => {
  delete process.env.WIKI_CREDENTIALS;
  assert.match(credentialPath(), /\/ywiki\/credentials\.toml$/);
});

test("valid iam credential is parsed", () => {
  writeCred(iam());
  const c = credentials();
  assert.equal(c.scheme, "iam");
  assert.equal(c.org, "b1g1234567890abcdef");
  assert.equal(c.token, iam());
});

test("missing file throws unauthenticated", () => {
  try {
    credentials();
    assert.fail("expected AuthError");
  } catch (e) {
    assert.ok(e instanceof AuthError);
    assert.equal(e.kind, "unauthenticated");
    assert.match(e.message, /ywiki auth login/);
  }
});

test("version=3 is rejected", () => {
  writeFileSync(process.env.WIKI_CREDENTIALS, 'version = 3\ntoken = "x"\n');
  assert.throws(() => credentials(), /version=3/);
});

test("non-iam token is rejected for scheme=iam", () => {
  writeCred("not-an-iam-token");
  assert.throws(() => credentials(), /IAM token/);
});

test("oauth scheme uses the OAuth keyword", () => {
  writeCred(oauth(), "oauth");
  const h = authHeaders(credentials());
  assert.equal(h.Authorization, `OAuth ${oauth()}`);
});

test("numeric organization selects X-Org-Id", () => {
  writeCred(iam(), "iam", "12345");
  assert.equal(authHeaders(credentials())["X-Org-Id"], "12345");
});

test("non-numeric organization selects X-Cloud-Org-Id", () => {
  writeCred(iam(), "iam", "b1g123");
  assert.equal(authHeaders(credentials())["X-Cloud-Org-Id"], "b1g123");
});

test("WIKI_IAM_TOKEN overrides the file", () => {
  writeCred(iam("A".repeat(40)));
  process.env.WIKI_IAM_TOKEN = iam("B".repeat(40));
  process.env.WIKI_ORGANIZATION_ID = "b1g-env";
  const c = credentials();
  assert.equal(c.token, iam("B".repeat(40)));
  assert.equal(c.scheme, "iam");
  assert.equal(c.org, "b1g-env");
});

test("WIKI_TOKEN is treated as oauth", () => {
  process.env.WIKI_TOKEN = oauth();
  process.env.WIKI_ORGANIZATION_ID = "b1g-env";
  const c = envCredentials();
  assert.equal(c?.scheme, "oauth");
  assert.equal(authHeaders(c).Authorization, `OAuth ${oauth()}`);
});

test("LEGACY_* variables are ignored", () => {
  process.env.LEGACY_IAM_TOKEN = iam();
  process.env.LEGACY_ORGANIZATION_ID = "b1g-tracker";
  assert.throws(() => credentials(), /ywiki auth login/);
});

test("mtime change re-reads the file", () => {
  writeCred(iam("A".repeat(40)));
  assert.equal(credentials().token, iam("A".repeat(40)));
  writeCred(iam("B".repeat(40)));
  const future = new Date(Date.now() + 5000);
  utimesSync(process.env.WIKI_CREDENTIALS, future, future);
  assert.equal(credentials().token, iam("B".repeat(40)));
});

test("redact hides the token and keeps a short prefix", () => {
  writeCred(iam());
  credentials();
  const out = redact(`Authorization: Bearer ${iam()}`);
  assert.ok(!out.includes(iam()));
  assert.match(out, /t1\.AAA/);
});

test("writeCredential stores a 0600 file and readCredentialFile reads it", () => {
  writeCredential({
    token: iam(),
    scheme: "iam",
    org: "b1g123",
    mtimeMs: 0,
  });
  const text = readFileSync(process.env.WIKI_CREDENTIALS, "utf8");
  assert.match(text, /version = 2/);
  assert.match(text, /scheme = "iam"/);
  assert.equal(statSync(process.env.WIKI_CREDENTIALS).mode & 0o777, 0o600);
  const c = readCredentialFile();
  assert.equal(c?.token, iam());
});

test("optional refresh metadata is parsed", () => {
  writeFileSync(
    process.env.WIKI_CREDENTIALS,
    [
      "version = 2",
      `token = "${oauth()}"`,
      'scheme = "oauth"',
      'organization_id = "b1g123"',
      'refresh_token = "refresh-secret-value"',
      "client_id = \"client-id\"",
      'token_endpoint = "https://example.test/token"',
      "",
    ].join("\n"),
  );
  const c = readCredentialFile();
  assert.equal(c?.refreshToken, "refresh-secret-value");
  assert.equal(c?.clientId, "client-id");
  assert.equal(c?.tokenEndpoint, "https://example.test/token");
});

test("tokens with line breaks are rejected", () => {
  assert.throws(
    () => validate({ token: "abc\ndef", scheme: "oauth", org: "b1g123", mtimeMs: 0 }),
    /перевод строки/,
  );
});

test("removeCredential deletes the file and is idempotent", () => {
  writeCred(iam());
  assert.equal(removeCredential(), true);
  assert.equal(removeCredential(), false);
  assert.throws(() => credentials(), /ywiki auth login/);
});
