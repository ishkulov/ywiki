// ywiki/tests/refresh.test.mjs
// T4 tests: inter-process refresh with stub LEGACY_AUTH. The real the legacy refresh helper is
// NEVER executed here. All state (lock, cooldown, counter) lives in a tmp dir.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { refreshOnce } from "../lib/refresh.mjs";
import { AuthError } from "../lib/credentials.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const OK = join(FIX, "stub-auth-ok.mjs");
const FAIL = join(FIX, "stub-auth-fail.mjs");
const HANG = join(FIX, "stub-auth-hang.mjs");

/** @type {string} */
let dir;
/** @type {string} */
let counter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ywiki-t4-"));
  counter = join(dir, "counter");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** @param {string} p @returns {number} */
function runs(p = counter) {
  try {
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test("successful refresh writes the cooldown mark and no lock remains", async () => {
  const prev = process.env.COUNTER_FILE;
  process.env.COUNTER_FILE = counter;
  try {
    await refreshOnce({ cacheDir: dir, stAuth: OK, run: undefined });
    assert.equal(runs(), 1);
    assert.ok(existsSync(join(dir, "last-refresh")), "cooldown mark written");
    assert.ok(!existsSync(join(dir, "refresh.lock")), "lock released");
  } finally {
    if (prev === undefined) delete process.env.COUNTER_FILE;
    else process.env.COUNTER_FILE = prev;
  }
});

test("cooldown blocks a second refresh", async () => {
  const prev = process.env.COUNTER_FILE;
  process.env.COUNTER_FILE = counter;
  try {
    await refreshOnce({ cacheDir: dir, stAuth: OK });
    await refreshOnce({ cacheDir: dir, stAuth: OK });
    assert.equal(runs(), 1, "second call is suppressed by cooldown");
  } finally {
    if (prev === undefined) delete process.env.COUNTER_FILE;
    else process.env.COUNTER_FILE = prev;
  }
});

test("failing refresh throws AuthError(unavailable) and redacts the token", async () => {
  const prev = process.env.COUNTER_FILE;
  process.env.COUNTER_FILE = counter;
  try {
    let err;
    try {
      await refreshOnce({ cacheDir: dir, stAuth: FAIL });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof AuthError);
    assert.equal(err.kind, "unavailable");
    assert.ok(!/t1\.[A-Za-z0-9]{16,}/.test(err.message), "token must be redacted");
    assert.ok(!existsSync(join(dir, "last-refresh")), "no cooldown mark on failure");
  } finally {
    if (prev === undefined) delete process.env.COUNTER_FILE;
    else process.env.COUNTER_FILE = prev;
  }
});

test("hanging refresh is aborted within the timeout (<= 30s)", async () => {
  const prev = process.env.COUNTER_FILE;
  process.env.COUNTER_FILE = counter;
  try {
    const t0 = Date.now();
    let err;
    try {
      await refreshOnce({ cacheDir: dir, stAuth: HANG, execTimeoutMs: 1500 });
    } catch (e) {
      err = e;
    }
    const dt = Date.now() - t0;
    assert.ok(err instanceof AuthError, "must throw");
    assert.ok(dt <= 30000, `aborted in ${dt}ms`);
    assert.ok(dt >= 1400, `waited for the timeout (${dt}ms)`);
    assert.ok(!existsSync(join(dir, "refresh.lock")), "lock released after timeout");
  } finally {
    if (prev === undefined) delete process.env.COUNTER_FILE;
    else process.env.COUNTER_FILE = prev;
  }
});

test("a stale lock is cleared and the refresh proceeds", async () => {
  const prev = process.env.COUNTER_FILE;
  process.env.COUNTER_FILE = counter;
  try {
    const lock = join(dir, "refresh.lock");
    writeFileSync(lock, "999 0");
    const old = new Date(Date.now() - 120000);
    // Force the lock's mtime into the past.
    const { utimesSync } = await import("node:fs");
    utimesSync(lock, old, old);
    await refreshOnce({ cacheDir: dir, stAuth: OK, staleMs: 60000 });
    assert.equal(runs(), 1, "refresh ran after clearing the stale lock");
    assert.ok(!existsSync(lock));
  } finally {
    if (prev === undefined) delete process.env.COUNTER_FILE;
    else process.env.COUNTER_FILE = prev;
  }
});

test("a live lock is respected: contender waits, then reports busy", async () => {
  const prev = process.env.COUNTER_FILE;
  process.env.COUNTER_FILE = counter;
  try {
    // Simulate an in-flight refresh from another process: fresh lock, no mark.
    writeFileSync(join(dir, "refresh.lock"), "12345 " + Date.now());
    let err;
    try {
      await refreshOnce({ cacheDir: dir, stAuth: OK, lockWaitMs: 300, sleepFn: async () => {} });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof AuthError, "must not silently succeed");
    assert.equal(err.kind, "unavailable");
    assert.equal(runs(), 0, "contender did not run the script itself");
  } finally {
    if (prev === undefined) delete process.env.COUNTER_FILE;
    else process.env.COUNTER_FILE = prev;
  }
});

test("concurrent processes trigger a single refresh (cross-process single-flight)", async () => {
  const counterFile = join(dir, "cc-counter");
  const moduleUrl = pathToFileURL(join(HERE, "..", "lib", "refresh.mjs")).href;
  const code = `import { refreshOnce } from ${JSON.stringify(moduleUrl)};
try { await refreshOnce({ cacheDir: ${JSON.stringify(dir)}, stAuth: ${JSON.stringify(OK)} }); } catch {}
`;
  const env = {
    ...process.env,
    COUNTER_FILE: counterFile,
    // Make the first runner hold the lock briefly so all 5 start together.
  };
  const children = Array.from({ length: 5 }, () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env });
      child.on("exit", resolve);
    }),
  );
  await Promise.all(children);
  const count = runs(counterFile);
  assert.equal(count, 1, `expected exactly 1 refresh, got ${count}`);
});
