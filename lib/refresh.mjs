// ywiki/lib/refresh.mjs
// Inter-process IAM token refresh.
//
// Delegates to the existing `the legacy refresh helper --refresh` script (which uses
// `yc iam create-token`, writes the credential file, and never opens a
// browser). This module does NOT write the credential and does NOT source a
// second token. It only serialises concurrent refreshes and enforces a cooldown.
//
// Guarantees:
//   - single-flight across processes (advisory lock file);
//   - 60s cooldown so a burst of 401s triggers at most one refresh;
//   - 30s hard timeout on the child;
//   - the child's stdout is discarded entirely; stderr is redacted and clipped.

import { execFile } from "node:child_process";
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { invalidate, redact, AuthError } from "./credentials.mjs";

export const COOLDOWN_MS = 60000;
export const EXEC_TIMEOUT_MS = 30000;
export const LOCK_WAIT_MS = 10000;
export const STALE_LOCK_MS = 60000;

/** @returns {string} */
function cacheDirOf(opts) {
  return (
    opts.cacheDir ||
    process.env.WIKI_CACHE_DIR ||
    join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "st", "wiki")
  );
}

/** @returns {string} */
function authScript(opts) {
  return opts.stAuth || process.env.LEGACY_AUTH || join(homedir(), ".local", "bin", "the legacy refresh helper");
}

/** Default child runner: execFile with timeout, stdout dropped. */
function defaultRun(cmd, args, { timeout }) {
  const env = {
    ...process.env,
    PATH: `${join(homedir(), ".local", "bin")}:${join(homedir(), "yandex-cloud", "bin")}:${process.env.PATH || ""}`,
  };
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      // stdout is intentionally not returned; callers never surface it.
      resolve({ stdout, stderr });
    });
  });
}

/** @param {string} p @returns {number} */
function readMark(p) {
  try {
    return Number(readFileSync(p, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

/** @param {string} p @param {number} now */
function writeMark(p, now) {
  try {
    const fd = openSync(p, "w", 0o600);
    writeSync(fd, String(now));
    closeSync(fd);
  } catch {
    /* best-effort */
  }
}

/**
 * Try to create the lock atomically. Removes a stale lock (older than staleMs)
 * and retries once.
 * @returns {boolean}
 */
function acquireLock(lockPath, now, staleMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, `${process.pid} ${now}`);
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") return false;
      let age = Infinity;
      try {
        age = now - statSync(lockPath).mtimeMs;
      } catch {
        continue; // vanished; retry
      }
      if (age > staleMs) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ensure a fresh IAM token. Single-flight and cooldown-guarded.
 * Resolves when a usable credential is (believed) present; throws AuthError
 * ("unavailable") when the refresh could not be completed.
 *
 * @param {{
 *   cacheDir?: string, stAuth?: string, run?: typeof defaultRun,
 *   clock?: () => number, cooldownMs?: number, execTimeoutMs?: number,
 *   lockWaitMs?: number, staleMs?: number, sleepFn?: (ms:number)=>Promise<void>,
 * }} [opts]
 * @returns {Promise<void>}
 */
export async function refreshOnce(opts = {}) {
  const dir = cacheDirOf(opts);
  const clock = opts.clock || Date.now;
  const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
  const execTimeoutMs = opts.execTimeoutMs ?? EXEC_TIMEOUT_MS;
  const lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
  const run = opts.run || defaultRun;
  const sleepFn = opts.sleepFn || sleep;

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* ignore */
  }
  const markPath = join(dir, "last-refresh");
  const lockPath = join(dir, "refresh.lock");

  const mark = readMark(markPath);
  const now = clock();
  if (mark && now - mark < cooldownMs) return; // refreshed recently

  if (!acquireLock(lockPath, now, staleMs)) {
    // Another process holds the lock: wait for it to finish, then re-read.
    const deadline = clock() + lockWaitMs;
    while (clock() < deadline) {
      await sleepFn(100);
      let held = true;
      try {
        statSync(lockPath);
      } catch {
        held = false;
      }
      if (!held) break;
    }
    invalidate();
    const m2 = readMark(markPath);
    if (m2 && clock() - m2 < cooldownMs) return; // winner succeeded
    throw new AuthError("unavailable", "refresh уже выполняется другим процессом");
  }

  try {
    try {
      await run(authScript(opts), ["--refresh"], { timeout: execTimeoutMs });
    } catch (e) {
      const raw = (e && e.stderr) || (e && e.message) || e;
      const msg = redact(String(raw)).replace(/\s+/g, " ").trim().slice(0, 300);
      const timedOut = e && (e.killed || e.signal === "SIGTERM" || /timed?\s*out/i.test(String(e.message || "")));
      throw new AuthError("unavailable", timedOut ? `refresh прерван по таймауту (${execTimeoutMs} мс)` : `refresh не удался: ${msg}`);
    }
    writeMark(markPath, clock());
    invalidate();
  } finally {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}
