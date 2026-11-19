// ywiki/tests/refresh.test.mjs
// refreshOnce: own refresh path (yc for IAM, refresh_token for OAuth).
// The real `yc` is never executed here: a stub is used for the timeout and
// cross-process cases. Every test uses a tmp credential + cache dir.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { refreshOnce } from "../lib/refresh.mjs";
import { AuthError, invalidate, readCredentialFile } from "../lib/credentials.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const YC = join(FIX, "stub-yc.mjs");

const IAM_PREFIX = ["t", "1", "."].join("");
const iam = (body = "A".repeat(40)) => IAM_PREFIX + body;
const oauth = (body = "B".repeat(40)) => ["y", "0", "_"].join("") + body;

const ENV_KEYS = [
  "WIKI_CREDENTIALS",
  "WIKI_CACHE_DIR",
  "WIKI_IAM_TOKEN",
  "WIKI_TOKEN",
  "WIKI_ORGANIZATION_ID",
  "WIKI_YC_BIN",
  "STUB_YC_TOKEN",
  "STUB_YC_FAIL",
  "STUB_YC_HANG",
  "STUB_YC_COUNTER",
];

/** @type {Record<string, string | undefined>} */
const saved = {};
/** @type {string} */
let dir;
/** @type {string} */
let credPath;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  invalidate();
  dir = mkdtempSync(join(tmpdir(), "ywiki-refresh-"));
  credPath = join(dir, "credentials.toml");
  process.env.WIKI_CREDENTIALS = credPath;
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

/** @param {string} token @param {string} [scheme] @param {string} [org] */
function writeCred(token, scheme = "iam", org = "b1g1234567890abcdef") {
  writeFileSync(
    credPath,
    `version = 2\ntoken = "${token}"\nscheme = "${scheme}"\norganization_id = "${org}"\n`,
  );
}

/** @param {string} token @param {string} [org] */
function writeOauthCred(token, org = "b1g1234567890abcdef") {
  writeFileSync(
    credPath,
    [
      "version = 2",
      `token = "${token}"`,
      'scheme = "oauth"',
      `organization_id = "${org}"`,
      'refresh_token = "old-refresh-secret"',
      'client_id = "client-id"',
      'token_endpoint = "https://example.test/token"',
      "",
    ].join("\n"),
  );
}

/** @param {string} p @returns {number} */
function runs(p) {
  try {
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test("an ENV credential blocks file refresh with a clear message", async () => {
  writeCred(iam());
  process.env.WIKI_IAM_TOKEN = iam("B".repeat(40));
  process.env.WIKI_ORGANIZATION_ID = "b1g-env";

  let err;
  try {
    await refreshOnce({ cacheDir: dir, runYc: async () => iam("C".repeat(40)) });
  } catch (e) {
    err = e;
  }

  assert.ok(err instanceof AuthError);
  assert.equal(err.kind, "unauthenticated");
  assert.match(err.message, /WIKI_IAM_TOKEN/);
  assert.ok(!existsSync(join(dir, "last-refresh")), "no cooldown mark");
});

test("successful IAM refresh updates the credential and writes the cooldown mark", async () => {
  const oldToken = iam("A".repeat(40));
  const newToken = iam("B".repeat(40));
  writeCred(oldToken);

  let calls = 0;
  await refreshOnce({
    cacheDir: dir,
    runYc: async () => {
      calls++;
      return newToken;
    },
  });

  assert.equal(calls, 1);
  const text = readFileSync(credPath, "utf8");
  assert.ok(text.includes(newToken), "credential updated with the new token");
  assert.ok(!text.includes(oldToken), "old token replaced");
  assert.ok(existsSync(join(dir, "last-refresh")), "cooldown mark written");
  assert.ok(!existsSync(join(dir, "refresh.lock")), "lock released");
});

test("cooldown blocks a second refresh", async () => {
  writeCred(iam());
  let calls = 0;
  const runYc = async () => {
    calls++;
    return iam("B".repeat(40));
  };

  await refreshOnce({ cacheDir: dir, runYc });
  await refreshOnce({ cacheDir: dir, runYc });

  assert.equal(calls, 1, "second call is suppressed by cooldown");
});

test("failing refresh throws AuthError(unavailable) and redacts the token", async () => {
  const secret = iam("A".repeat(40));
  writeCred(secret);

  let err;
  try {
    await refreshOnce({
      cacheDir: dir,
      runYc: async () => {
        throw new Error(`yc failed near ${secret}`);
      },
    });
  } catch (e) {
    err = e;
  }

  assert.ok(err instanceof AuthError, "must throw AuthError");
  assert.equal(err.kind, "unavailable");
  assert.ok(!err.message.includes(secret), "token must be redacted");
  assert.ok(!existsSync(join(dir, "last-refresh")), "no cooldown mark on failure");
  assert.ok(!existsSync(join(dir, "refresh.lock")), "lock released on failure");
});

test("hanging refresh is aborted by the exec timeout", async () => {
  writeCred(iam());
  process.env.STUB_YC_HANG = "1";

  const t0 = Date.now();
  let err;
  try {
    await refreshOnce({ cacheDir: dir, ycBin: YC, execTimeoutMs: 1000 });
  } catch (e) {
    err = e;
  }
  const dt = Date.now() - t0;

  assert.ok(err instanceof AuthError, "must throw");
  assert.equal(err.kind, "unavailable");
  assert.ok(dt >= 800, `waited for the timeout (${dt}ms)`);
  assert.ok(dt < 15000, `aborted quickly (${dt}ms)`);
  assert.ok(!existsSync(join(dir, "refresh.lock")), "lock released after timeout");
});

test("a stale lock is cleared and the refresh proceeds", async () => {
  writeCred(iam());
  const lock = join(dir, "refresh.lock");
  writeFileSync(lock, "999");
  const old = new Date(Date.now() - 120000);
  utimesSync(lock, old, old);

  let calls = 0;
  await refreshOnce({
    cacheDir: dir,
    staleMs: 60000,
    runYc: async () => {
      calls++;
      return iam("B".repeat(40));
    },
  });

  assert.equal(calls, 1, "refresh ran after clearing the stale lock");
  assert.ok(!existsSync(lock), "stale lock removed");
});

test("a live lock is respected: contender waits, then reports busy", async () => {
  writeCred(iam());
  const lock = join(dir, "refresh.lock");
  writeFileSync(lock, "12345");

  let calls = 0;
  let err;
  try {
    await refreshOnce({
      cacheDir: dir,
      lockWaitMs: 300,
      sleepFn: async () => {},
      runYc: async () => {
        calls++;
        return iam("B".repeat(40));
      },
    });
  } catch (e) {
    err = e;
  }

  assert.ok(err instanceof AuthError, "must not silently succeed");
  assert.equal(err.kind, "unavailable");
  assert.equal(calls, 0, "contender did not run the refresh itself");
});

test("OAuth refresh uses refresh_token and stores the rotated token", async () => {
  const oldToken = oauth("A".repeat(40));
  const newToken = oauth("B".repeat(40));
  writeOauthCred(oldToken);

  let seen;
  await refreshOnce({
    cacheDir: dir,
    refreshOAuth: async (opts) => {
      seen = opts;
      return { access_token: newToken, refresh_token: "new-refresh-secret", expires_in: 3600 };
    },
  });

  assert.equal(seen.refreshToken, "old-refresh-secret");
  assert.equal(seen.clientId, "client-id");
  const creds = readCredentialFile();
  assert.equal(creds?.token, newToken);
  assert.equal(creds?.refreshToken, "new-refresh-secret");
  assert.ok(creds?.expiresAt > Date.now(), "expiry stored");
  assert.ok(existsSync(join(dir, "last-refresh")));
});

test("concurrent processes trigger a single refresh (cross-process single-flight)", async () => {
  const counterFile = join(dir, "cc-counter");
  writeCred(iam("A".repeat(40)));

  const moduleUrl = pathToFileURL(join(HERE, "..", "lib", "refresh.mjs")).href;
  const code = `import { refreshOnce } from ${JSON.stringify(moduleUrl)};
try { await refreshOnce({ cacheDir: ${JSON.stringify(dir)} }); } catch { process.exitCode = 1; }
`;
  const env = {
    ...process.env,
    WIKI_CREDENTIALS: credPath,
    WIKI_YC_BIN: YC,
    STUB_YC_COUNTER: counterFile,
    STUB_YC_TOKEN: iam("B".repeat(40)),
  };
  delete env.WIKI_IAM_TOKEN;
  delete env.WIKI_TOKEN;
  delete env.STUB_YC_FAIL;
  delete env.STUB_YC_HANG;

  const children = Array.from({ length: 5 }, () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env });
      child.on("exit", (code) => resolve(code));
    }),
  );
  const codes = await Promise.all(children);

  assert.deepEqual(codes, [0, 0, 0, 0, 0], "every contender exits cleanly");
  const count = runs(counterFile);
  assert.equal(count, 1, `expected exactly 1 refresh, got ${count}`);
});
