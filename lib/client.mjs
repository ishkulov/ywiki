// ywiki/lib/client.mjs
// Read-only HTTP client for the Yandex Wiki API.
//
// Responsibilities: build URLs from confirmed endpoints, attach auth headers
// from lib/credentials.mjs, enforce a timeout, retry transient failures
// (429/5xx), cache successful reads on disk (never headers, never tokens), and
// map HTTP status to the typed WikiError taxonomy.
//
// All network access is injected via `fetchImpl` so tests can run offline.

import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { credentials, invalidate, authHeaders, redact, AuthError } from "./credentials.mjs";
import { WikiError } from "./output.mjs";

export const BASE_URL = "https://api.wiki.yandex.net/v1";
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_RETRIES = 3; // attempts total for 429/5xx
export const CACHE_TTL_MS = 60000;

/** Endpoints where a 401 self-heal retry is permitted (read-only). */
const RETRYABLE_ON_401 = ["/pages", "/pages/descendants", "/spaces", "/users/me", "/search"];

/** @param {string} p */
function isRetryableOn401(p) {
  const path = p.split("?")[0];
  return RETRYABLE_ON_401.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}

/** @param {Record<string, unknown>} [query] */
export function buildQuery(query) {
  if (!query) return "";
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Disk cache. Stores `{status, body, ts}` keyed by sha256(method+url+body).
 * Only successful (2xx) reads are stored. No headers, no tokens.
 */
class DiskCache {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
  }
  /** @param {string} key @returns {string} */
  file(key) {
    return join(this.dir, key + ".json");
  }
  /**
   * @param {string} key
   * @param {number} now
   * @param {number} ttl
   * @returns {{status:number, body:string} | null}
   */
  get(key, now, ttl) {
    try {
      const raw = readFileSync(this.file(key), "utf8");
      const entry = JSON.parse(raw);
      if (now - entry.ts > ttl) return null;
      return { status: entry.status, body: entry.body };
    } catch {
      return null;
    }
  }
  /** @param {string} key @param {number} status @param {string} body @param {number} now */
  set(key, status, body, now) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.file(key), JSON.stringify({ status, body, ts: now }), { mode: 0o600 });
      this.prune();
    } catch {
      // cache is best-effort
    }
  }
  prune() {
    try {
      const names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
      if (names.length <= 200) return;
      const withTime = names.map((n) => {
        let m = 0;
        try {
          m = statSync(join(this.dir, n)).mtimeMs;
        } catch {
          /* ignore */
        }
        return { n, m };
      });
      withTime.sort((a, b) => a.m - b.m);
      for (const { n } of withTime.slice(0, withTime.length - 200)) {
        try {
          rmSync(join(this.dir, n), { force: true });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   refresh?: () => Promise<void>,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   retries?: number,
 *   cacheDir?: string,
 *   noCache?: boolean,
 *   clock?: () => number,
 *   sleepFn?: (ms: number) => Promise<void>,
 * }} [opts]
 */
export function createClient(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const baseUrl = opts.baseUrl || process.env.WIKI_BASE_URL || BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const clock = opts.clock || Date.now;
  const sleepFn = opts.sleepFn || sleep;
  const noCache = opts.noCache ?? process.env.WIKI_NO_CACHE === "1";
  const cacheDir =
    opts.cacheDir || process.env.WIKI_CACHE_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "st", "wiki");
  const cache = new DiskCache(cacheDir);
  const refresh = opts.refresh || null;

  /**
   * Single HTTP attempt with timeout.
   * @param {string} method
   * @param {string} url
   * @param {string | undefined} body
   * @param {Record<string,string>} headers
   */
  async function once(method, url, body, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      return { status: res.status, text };
    } catch (e) {
      if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) {
        throw new WikiError("upstream_unavailable", `таймаут запроса (${timeoutMs} мс)`);
      }
      throw new WikiError("upstream_unavailable", `сетевая ошибка: ${redact(e && e.message)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Perform a request with cache, retries and 401 self-heal.
   * @param {string} endpoint path + optional query, e.g. "/pages?slug=x"
   * @param {{ method?: string, body?: unknown }} [init]
   * @returns {Promise<any>} parsed JSON
   */
  async function request(endpoint, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const url = baseUrl + endpoint;
    const cacheKey = createHash("sha256").update(`${method}\n${endpoint}\n${body || ""}`).digest("hex");

    if (!noCache) {
      const hit = cache.get(cacheKey, clock(), CACHE_TTL_MS);
      if (hit) return JSON.parse(hit.body);
    }

    /** @type {Record<string,string>} */
    let headers;
    try {
      headers = { ...authHeaders(credentials()) };
    } catch (e) {
      if (e instanceof AuthError) throw new WikiError("auth_unavailable", redact(e.message));
      throw e;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let healed = false;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await once(method, url, body, headers);
      } catch (e) {
        // timeout / network: retry as transient
        if (attempt < retries) {
          await sleepFn(500 * 2 ** (attempt - 1));
          continue;
        }
        throw e;
      }

      if (res.status === 401) {
        if (!healed && refresh && isRetryableOn401(endpoint)) {
          healed = true;
          try {
            await refresh();
          } catch (e) {
            if (e instanceof WikiError) throw e;
            throw new WikiError("auth_unavailable", redact(e && e.message));
          }
          invalidate();
          try {
            headers = { ...authHeaders(credentials()) };
          } catch (e) {
            if (e instanceof AuthError) throw new WikiError("auth_unavailable", redact(e.message));
            throw e;
          }
          if (body !== undefined) headers["Content-Type"] = "application/json";
          continue;
        }
        throw new WikiError("auth_unavailable", "401 Unauthorized (токен недействителен; повторите после refresh)");
      }
      if (res.status === 403) {
        throw new WikiError("access_denied", `403 Forbidden: нет доступа к ${endpoint.split("?")[0]}`);
      }
      if (res.status === 404) {
        throw new WikiError("not_found", `404: не найдено ${endpoint.split("?")[0]}`);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await sleepFn(500 * 2 ** (attempt - 1));
          continue;
        }
        throw new WikiError("upstream_unavailable", `HTTP ${res.status} после ${retries} попыток`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new WikiError("upstream_unavailable", `HTTP ${res.status}: ${redact(res.text).slice(0, 200)}`);
      }

      if (!noCache) cache.set(cacheKey, res.status, res.text, clock());
      try {
        return JSON.parse(res.text);
      } catch {
        return res.text;
      }
    }
  }

  return { request, baseUrl, cacheDir };
}
