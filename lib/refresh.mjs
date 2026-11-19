// ywiki/lib/refresh.mjs
// Own refresh path for ywiki credentials.
//
// IAM  -> `yc iam create-token` (single-flight, cooldown-guarded).
// OAuth -> refresh_token when present; otherwise the caller must log in again.

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

import { AuthError, cacheDir, hasEnvCredential, invalidate, readCredentialFile, redact, writeCredential } from "./credentials.mjs";
import { runYcToken } from "./auth.mjs";
import { refreshAccessToken } from "./oauth.mjs";

export const COOLDOWN_MS = 60000;
export const EXEC_TIMEOUT_MS = 30000;
export const LOCK_WAIT_MS = 10000;
export const STALE_LOCK_MS = 60000;

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/** @param {string} lockPath @param {number} now @param {number} staleMs @returns {boolean} */
function acquireLock(lockPath, now, staleMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(now));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e && /** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") {
        try {
          const st = statSync(lockPath);
          if (now - st.mtimeMs > staleMs) {
            rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          /* ignore */
        }
      }
      return false;
    }
  }
  return false;
}

/**
 * Ensure a fresh credential. Single-flight and cooldown-guarded.
 * @param {{
 *   cacheDir?: string,
 *   runYc?: typeof runYcToken,
 *   refreshOAuth?: typeof refreshAccessToken,
 *   clock?: () => number,
 *   cooldownMs?: number,
 *   execTimeoutMs?: number,
 *   lockWaitMs?: number,
 *   staleMs?: number,
 *   sleepFn?: (ms: number) => Promise<void>,
 *   ycBin?: string,
 *   ycProfile?: string,
 *   fetchImpl?: typeof fetch,
 * }} [opts]
 * @returns {Promise<void>}
 */
export async function refreshOnce(opts = {}) {
  if (hasEnvCredential()) {
    throw new AuthError(
      "unauthenticated",
      "активен WIKI_IAM_TOKEN или WIKI_TOKEN; обновите переменную окружения или снимите её и выполните `ywiki auth login`",
    );
  }
  const dir = opts.cacheDir || cacheDir();
  const clock = opts.clock || Date.now;
  const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
  const execTimeoutMs = opts.execTimeoutMs ?? EXEC_TIMEOUT_MS;
  const lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
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
  if (mark && now - mark < cooldownMs) return;

  if (!acquireLock(lockPath, now, staleMs)) {
    const deadline = clock() + lockWaitMs;
    while (clock() < deadline) {
      await sleepFn(100);
      try {
        statSync(lockPath);
      } catch {
        break;
      }
    }
    invalidate();
    const m2 = readMark(markPath);
    if (m2 && clock() - m2 < cooldownMs) return;
    throw new AuthError("unavailable", "refresh уже выполняется другим процессом");
  }

  try {
    const creds = readCredentialFile();
    if (!creds) {
      throw new AuthError("unauthenticated", "креденшел не найден; выполните `ywiki auth login`");
    }
    if (creds.scheme === "iam") {
      const token = await (opts.runYc || runYcToken)({
        bin: opts.ycBin,
        profile: opts.ycProfile,
        timeoutMs: execTimeoutMs,
      });
      writeCredential({ ...creds, token, mtimeMs: Date.now() });
    } else if (creds.scheme === "oauth") {
      if (!creds.refreshToken || !creds.clientId) {
        throw new AuthError(
          "unauthenticated",
          "OAuth-токен истёк, а refresh token не сохранён; выполните `ywiki auth login`",
        );
      }
      const data = await (opts.refreshOAuth || refreshAccessToken)({
        tokenEndpoint: creds.tokenEndpoint,
        clientId: creds.clientId,
        refreshToken: creds.refreshToken,
        fetchImpl: opts.fetchImpl,
        timeoutMs: execTimeoutMs,
      });
      const expiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined;
      writeCredential({
        ...creds,
        token: data.access_token,
        refreshToken: data.refresh_token || creds.refreshToken,
        expiresAt,
        mtimeMs: Date.now(),
      });
    } else {
      throw new AuthError("unauthenticated", `неизвестная схема креденшела: ${creds.scheme}`);
    }
    writeMark(markPath, clock());
    invalidate();
  } catch (e) {
    if (e instanceof AuthError) throw e;
    const msg = redact(String((e && e.message) || e)).replace(/\s+/g, " ").trim().slice(0, 300);
    throw new AuthError("unavailable", `refresh не удался: ${msg}`);
  } finally {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}
