// ywiki/lib/oauth.mjs
// Minimal OAuth 2.0 + PKCE helpers for Yandex OAuth.
//
// No dependencies: node:crypto, node:http and node:child_process only.
// The browser callback stays on 127.0.0.1 and the token never enters argv.

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { platform } from "node:os";

import { AuthError, redact } from "./credentials.mjs";

export const AUTHORIZE_ENDPOINT = "https://oauth.yandex.ru/authorize";
export const TOKEN_ENDPOINT = "https://oauth.yandex.ru/token";
export const CALLBACK_PATH = "/callback";
export const DEFAULT_PORTS = [21332, 24816, 28934];
export const DEFAULT_TIMEOUT_MS = 300000;

/** @typedef {{ verifier: string, challenge: string }} Pkce */

/** @returns {Pkce} */
export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

/** @returns {string} */
export function randomState() {
  return randomBytes(32).toString("base64url");
}

/**
 * Authorization URL for the code flow.
 * @param {{
 *   clientId: string,
 *   redirectUri: string,
 *   state: string,
 *   challenge: string,
 *   scope?: string,
 *   authorizeEndpoint?: string,
 * }} opts
 * @returns {string}
 */
export function buildAuthorizeUrl(opts) {
  const url = new URL(opts.authorizeEndpoint || AUTHORIZE_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.scope) url.searchParams.set("scope", opts.scope);
  return url.toString();
}

/**
 * Token page for the "paste a token" login method.
 * @param {{ clientId: string, redirectUri?: string, authorizeEndpoint?: string }} opts
 * @returns {string}
 */
export function buildTokenPageUrl(opts) {
  const url = new URL(opts.authorizeEndpoint || AUTHORIZE_ENDPOINT);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("client_id", opts.clientId);
  if (opts.redirectUri) url.searchParams.set("redirect_uri", opts.redirectUri);
  return url.toString();
}

/**
 * Open a URL in the desktop browser. Best-effort; returns false when no opener
 * is available. The caller should print the URL regardless.
 * @param {string} url
 * @param {{ run?: typeof execFile }} [opts]
 * @returns {Promise<boolean>}
 */
export function openBrowser(url, opts = {}) {
  const run = opts.run || execFile;
  const p = platform();
  let cmd;
  let args;
  if (p === "darwin") {
    cmd = "open";
    args = [url];
  } else if (p === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  return new Promise((resolve) => {
    try {
      run(cmd, args, { timeout: 5000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Start a loopback callback server. Tries the given ports in order.
 * @param {{
 *   ports?: number[],
 *   host?: string,
 *   path?: string,
 *   state: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{ redirectUri: string, done: Promise<string>, close: () => Promise<void> }>}
 */
export async function startCallbackServer(opts) {
  const ports = opts.ports || DEFAULT_PORTS;
  const host = opts.host || "127.0.0.1";
  const path = opts.path || CALLBACK_PATH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** @type {import("node:http").Server | null} */
  let server = null;
  let timer = null;
  let settled = false;
  /** @type {(code: string) => void} */
  let resolveCode = () => {};
  /** @type {(err: Error) => void} */
  let rejectCode = () => {};

  const done = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const cleanup = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (server) {
      const s = server;
      server = null;
      await new Promise((resolve) => {
        try {
          s.closeAllConnections?.();
          s.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  };

  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    cleanup().finally(() => fn(value));
  };

  const handler = (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://${host}`);
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("Bad request");
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("Authorization was not granted. You can close this window.");
      finish(rejectCode, new AuthError("unauthenticated", `OAuth authorization refused: ${error}`));
      return;
    }
    if (url.searchParams.get("state") !== opts.state) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("State mismatch.");
      finish(rejectCode, new AuthError("unauthenticated", "OAuth callback state mismatch"));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("Missing code.");
      finish(rejectCode, new AuthError("unauthenticated", "OAuth callback without code"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
    res.end("<!doctype html><meta charset=\"utf-8\"><title>ywiki</title><p>Authorization complete. You can close this window.</p>");
    finish(resolveCode, code);
  };

  for (const port of ports) {
    const candidate = createServer(handler);
    const ok = await new Promise((resolve) => {
      const onError = (err) => {
        candidate.off("listening", onListening);
        if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE") resolve(false);
        else resolve(false);
      };
      const onListening = () => {
        candidate.off("error", onError);
        resolve(true);
      };
      candidate.once("error", onError);
      candidate.once("listening", onListening);
      try {
        candidate.listen(port, host);
      } catch {
        resolve(false);
      }
    });
    if (ok) {
      server = candidate;
      break;
    }
    try {
      candidate.close();
    } catch {
      /* ignore */
    }
  }

  if (!server) {
    throw new AuthError("unavailable", `не удалось занять локальный порт для OAuth callback (${ports.join(", ")})`);
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : ports[0];
  const redirectUri = `http://${host}:${actualPort}${path}`;

  timer = setTimeout(() => {
    finish(rejectCode, new AuthError("unavailable", `OAuth callback не получен за ${Math.round(timeoutMs / 1000)} с`));
  }, timeoutMs);
  timer.unref?.();

  if (opts.signal) {
    if (opts.signal.aborted) {
      finish(rejectCode, new AuthError("unauthenticated", "OAuth login interrupted"));
    } else {
      opts.signal.addEventListener(
        "abort",
        () => finish(rejectCode, new AuthError("unauthenticated", "OAuth login interrupted")),
        { once: true },
      );
    }
  }

  return { redirectUri, done, close: cleanup };
}

/**
 * Exchange an authorization code for tokens. The redirect URI is not sent in
 * the token request, matching the legacy CLI's OAuth flow.
 * @param {{
 *   tokenEndpoint?: string,
 *   clientId: string,
 *   code: string,
 *   verifier: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ access_token: string, refresh_token?: string, expires_in?: number, token_type?: string }>}
 */
export async function exchangeCode(opts) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    code: opts.code,
    code_verifier: opts.verifier,
  });
  return tokenRequest(opts.tokenEndpoint || TOKEN_ENDPOINT, form, opts.fetchImpl, opts.timeoutMs);
}

/**
 * Refresh an OAuth access token.
 * @param {{
 *   tokenEndpoint?: string,
 *   clientId: string,
 *   refreshToken: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ access_token: string, refresh_token?: string, expires_in?: number, token_type?: string }>}
 */
export async function refreshAccessToken(opts) {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
  });
  return tokenRequest(opts.tokenEndpoint || TOKEN_ENDPOINT, form, opts.fetchImpl, opts.timeoutMs);
}

/**
 * @param {string} endpoint
 * @param {URLSearchParams} form
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [timeoutMs]
 */
async function tokenRequest(endpoint, form, fetchImpl = globalThis.fetch, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok || !data || typeof data.access_token !== "string") {
      const detail = data && (data.error_description || data.error);
      const msg = detail ? redact(String(detail)) : redact(text).slice(0, 200);
      throw new AuthError("unauthenticated", `OAuth token endpoint вернул HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
    }
    return data;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (e && (e.name === "AbortError" || e.name === "TimeoutError")) {
      throw new AuthError("unavailable", "OAuth token endpoint не ответил вовремя");
    }
    throw new AuthError("unavailable", `OAuth token endpoint недоступен: ${redact(e && e.message)}`);
  } finally {
    clearTimeout(timer);
  }
}
