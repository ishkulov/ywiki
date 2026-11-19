// ywiki/lib/auth.mjs
// Own authentication for ywiki: login, logout, status and token validation.
//
// The credential is ywiki's own (~/.config/ywiki/credentials.toml); no
// the legacy CLI credential and no the legacy refresh helper timer are involved.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { createClient } from "./client.mjs";
import {
  AuthError,
  credentialPath,
  credentials,
  envCredentials,
  hasEnvCredential,
  readCredentialFile,
  redact,
  registerSecret,
  removeCredential,
  tokenPrefix,
  writeCredential,
} from "./credentials.mjs";
import { UsageError, WikiError } from "./output.mjs";
import {
  AUTHORIZE_ENDPOINT,
  TOKEN_ENDPOINT,
  buildAuthorizeUrl,
  buildTokenPageUrl,
  exchangeCode,
  openBrowser,
  pkce,
  randomState,
  startCallbackServer,
} from "./oauth.mjs";

export const DEFAULT_YC_TIMEOUT_MS = 60000;
export const DEFAULT_CALLBACK_TIMEOUT_MS = 300000;

/** @param {string} org @returns {"yandex360" | "cloud"} */
export function organizationKind(org) {
  return /^\d+$/.test(String(org)) ? "yandex360" : "cloud";
}

/**
 * Build the OAuth token page URL used by `auth login --method token`.
 * @param {{ clientId?: string, redirectUri?: string, authorizeEndpoint?: string }} [opts]
 * @returns {string}
 */
export function tokenPageUrl(opts = {}) {
  if (!opts.clientId) return "";
  return buildTokenPageUrl({
    clientId: opts.clientId,
    redirectUri: opts.redirectUri,
    authorizeEndpoint: opts.authorizeEndpoint,
  });
}

/**
 * Run `yc iam create-token` without a browser. The token is returned in memory
 * only; stderr is redacted and never includes the token.
 * @param {{
 *   bin?: string,
 *   profile?: string,
 *   timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 *   run?: (args: string[], opts: { timeout: number, env: NodeJS.ProcessEnv }) => Promise<{ stdout: string, stderr: string }>,
 * }} [opts]
 * @returns {Promise<string>}
 */
export async function runYcToken(opts = {}) {
  const bin = opts.bin || process.env.WIKI_YC_BIN || "yc";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_YC_TIMEOUT_MS;
  const args = ["--no-browser"];
  if (opts.profile) args.push("--profile", opts.profile);
  args.push("iam", "create-token");
  const env = {
    ...(opts.env || process.env),
    PATH: `${join(homedir(), ".local", "bin")}:${join(homedir(), "yandex-cloud", "bin")}:${process.env.PATH || ""}`,
  };
  const run = opts.run || defaultRun;
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await run(args, { timeout: timeoutMs, env, bin }));
  } catch (e) {
    const raw = e && (e.stderr || e.message || e);
    const msg = redact(String(raw)).replace(/\s+/g, " ").trim().slice(0, 300);
    const timedOut = e && (e.killed || e.signal === "SIGTERM" || /timed?\s*out/i.test(String(e.message || "")));
    const hint = "Для автономного обновления нужны refresh token и файловый DPoP-ключ: один раз выполните `yc init --dpop` с браузером.";
    throw new AuthError(
      "unavailable",
      timedOut
        ? `yc не успел выдать IAM-токен за ${timeoutMs} мс. ${hint}`
        : `yc не смог выдать IAM-токен${msg ? `: ${msg}` : ""}. ${hint}`,
    );
  }
  const token = String(stdout || "").trim();
  if (!/^t1\.[A-Za-z0-9._-]{20,}$/.test(token)) {
    const detail = redact(String(stderr || "")).replace(/\s+/g, " ").trim().slice(0, 200);
    throw new AuthError(
      "unavailable",
      `yc вернул не IAM-токен${detail ? `: ${detail}` : ""}. Проверьте \`yc init --dpop\` и refresh token.`,
    );
  }
  registerSecret(token);
  return token;
}

/** @param {string[]} args @param {{ timeout: number, env: NodeJS.ProcessEnv, bin?: string }} opts */
function defaultRun(args, opts) {
  return new Promise((resolve, reject) => {
    execFile(opts.bin || "yc", args, { timeout: opts.timeout, env: opts.env, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Validate a candidate token against GET /users/me.
 * @param {{
 *   token: string,
 *   scheme: "iam" | "oauth",
 *   org: string,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<{ creds: any, identity: any }>}
 */
export async function validateToken(opts) {
  if (!opts.token) throw new AuthError("unauthenticated", "пустой токен");
  if (!opts.org) throw new UsageError("нужен --organization-id или WIKI_ORGANIZATION_ID");
  registerSecret(opts.token);
  const creds = {
    token: opts.token,
    scheme: opts.scheme,
    org: opts.org,
    mtimeMs: 0,
  };
  const client = createClient({
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
    noCache: true,
    credential: creds,
    refresh: null,
  });
  const identity = await client.request("/users/me");
  return { creds, identity };
}

/**
 * Try candidate schemes, validate against Wiki and persist the first success.
 * @param {{
 *   token: string,
 *   org: string,
 *   scheme?: "iam" | "oauth",
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   refreshToken?: string,
 *   expiresAt?: number,
 *   clientId?: string,
 *   tokenEndpoint?: string,
 * }} opts
 * @returns {Promise<{ creds: any, identity: any, path: string }>}
 */
export async function loginWithToken(opts) {
  if (!opts.token) throw new UsageError("нужен токен");
  if (!opts.org) throw new UsageError("нужен --organization-id или WIKI_ORGANIZATION_ID");
  registerSecret(opts.token);

  const schemes = opts.scheme
    ? [opts.scheme]
    : /^t1\./.test(opts.token)
      ? ["iam", "oauth"]
      : ["oauth", "iam"];

  let last;
  for (const scheme of schemes) {
    try {
      const { creds, identity } = await validateToken({
        token: opts.token,
        scheme: /** @type {"iam" | "oauth"} */ (scheme),
        org: opts.org,
        baseUrl: opts.baseUrl,
        timeoutMs: opts.timeoutMs,
        fetchImpl: opts.fetchImpl,
      });
      const stored = writeCredential({
        ...creds,
        refreshToken: opts.refreshToken,
        expiresAt: opts.expiresAt,
        clientId: opts.clientId,
        tokenEndpoint: opts.tokenEndpoint,
      });
      return { creds: stored, identity, path: credentialPath() };
    } catch (e) {
      last = e;
      if (e instanceof WikiError && e.kind !== "unauthenticated" && e.kind !== "access_denied") throw e;
      if (e instanceof AuthError && e.kind === "unavailable") throw e;
    }
  }
  if (last instanceof Error) throw last;
  throw new AuthError("unauthenticated", "Wiki отклонил токен (HTTP 401/403)");
}

/**
 * Obtain an IAM token via yc and store it.
 * @param {{ org: string, baseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch, ycBin?: string, ycProfile?: string, ycTimeoutMs?: number, run?: any }} opts
 */
export async function loginWithIam(opts) {
  const token = await runYcToken({
    bin: opts.ycBin,
    profile: opts.ycProfile,
    timeoutMs: opts.ycTimeoutMs,
    run: opts.run,
  });
  return loginWithToken({
    token,
    org: opts.org,
    scheme: "iam",
    baseUrl: opts.baseUrl,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * Browser OAuth 2.0 Authorization Code + PKCE.
 * @param {{
 *   org: string,
 *   clientId: string,
 *   scope?: string,
 *   ports?: number[],
 *   noOpen?: boolean,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   callbackTimeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   authorizeEndpoint?: string,
 *   tokenEndpoint?: string,
 *   onAuthorizeUrl?: (url: string) => void,
 *   openBrowserImpl?: typeof openBrowser,
 *   signal?: AbortSignal,
 * }} opts
 */
export async function loginWithBrowser(opts) {
  if (!opts.clientId) {
    throw new UsageError(
      "для browser-входа нужен OAuth client id: укажите --client-id или WIKI_OAUTH_CLIENT_ID (создайте приложение с доступом к Wiki API), либо используйте --method iam",
    );
  }
  if (!opts.org) throw new UsageError("нужен --organization-id или WIKI_ORGANIZATION_ID");

  const { verifier, challenge } = pkce();
  const state = randomState();
  let callback;
  try {
    callback = await startCallbackServer({
      ports: opts.ports,
      state,
      timeoutMs: opts.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
      signal: opts.signal,
    });
    callback.done.catch(() => {});
    const url = buildAuthorizeUrl({
      clientId: opts.clientId,
      redirectUri: callback.redirectUri,
      state,
      challenge,
      scope: opts.scope,
      authorizeEndpoint: opts.authorizeEndpoint,
    });
    if (opts.onAuthorizeUrl) opts.onAuthorizeUrl(url);
    if (!opts.noOpen) {
      const opened = await (opts.openBrowserImpl || openBrowser)(url);
      if (!opened && opts.onAuthorizeUrl) opts.onAuthorizeUrl(url);
    }
    const code = await callback.done;
    const data = await exchangeCode({
      tokenEndpoint: opts.tokenEndpoint,
      clientId: opts.clientId,
      code,
      verifier,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
    const expiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined;
    return await loginWithToken({
      token: data.access_token,
      scheme: "oauth",
      org: opts.org,
      baseUrl: opts.baseUrl,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      refreshToken: data.refresh_token,
      expiresAt,
      clientId: opts.clientId,
      tokenEndpoint: opts.tokenEndpoint || TOKEN_ENDPOINT,
    });
  } finally {
    if (callback) await callback.close();
  }
}

/**
 * Dispatch a login method.
 * @param {{ method?: "browser" | "token" | "iam" }} opts
 */
export async function login(opts) {
  const method = opts.method || "browser";
  if (method === "browser") return loginWithBrowser(opts);
  if (method === "iam") return loginWithIam(opts);
  if (method === "token") return loginWithToken(opts);
  throw new UsageError(`неизвестный метод входа: ${method} (browser, token, iam)`);
}

/**
 * Remove the local credential. Never touches the network.
 * @returns {{ removed: boolean, path: string }}
 */
export function logout() {
  if (hasEnvCredential()) {
    throw new UsageError("активен WIKI_IAM_TOKEN или WIKI_TOKEN; снимите переменную окружения, чтобы управлять файлом");
  }
  return { removed: removeCredential(), path: credentialPath() };
}

/**
 * Local credential status without a network call.
 * @returns {{
 *   present: boolean,
 *   source: "env" | "file" | "none",
 *   path: string | null,
 *   scheme: string | null,
 *   org: string | null,
 *   organizationKind: string | null,
 *   tokenPrefix: string | null,
 *   ageSeconds: number | null,
 *   expiresAt: number | null,
 *   hasRefreshToken: boolean,
 * }}
 */
export function status() {
  const env = envCredentials();
  if (env) {
    return {
      present: true,
      source: "env",
      path: null,
      scheme: env.scheme,
      org: env.org,
      organizationKind: organizationKind(env.org),
      tokenPrefix: tokenPrefix(env.token),
      ageSeconds: null,
      expiresAt: null,
      hasRefreshToken: false,
    };
  }
  const creds = readCredentialFile();
  if (!creds) {
    return {
      present: false,
      source: "none",
      path: credentialPath(),
      scheme: null,
      org: null,
      organizationKind: null,
      tokenPrefix: null,
      ageSeconds: null,
      expiresAt: null,
      hasRefreshToken: false,
    };
  }
  return {
    present: true,
    source: "file",
    path: credentialPath(),
    scheme: creds.scheme,
    org: creds.org,
    organizationKind: organizationKind(creds.org),
    tokenPrefix: tokenPrefix(creds.token),
    ageSeconds: creds.mtimeMs ? Math.round((Date.now() - creds.mtimeMs) / 1000) : null,
    expiresAt: creds.expiresAt ?? null,
    hasRefreshToken: Boolean(creds.refreshToken),
  };
}

/**
 * Read a secret without echoing it. On a TTY uses raw mode; otherwise reads the
 * first line from stdin.
 * @param {{ prompt?: string, input?: NodeJS.ReadStream, output?: NodeJS.WritableStream, noInput?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export async function readSecret(opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stderr;
  const prompt = opts.prompt || "Token: ";
  if (opts.noInput || !input.isTTY) {
    const text = await readAll(input);
    const line = text.split(/\r?\n/).find((s) => s.trim().length > 0);
    if (!line) throw new AuthError("unauthenticated", "токен не получен из stdin");
    return line.trim();
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      try {
        input.setRawMode(false);
      } catch {
        /* ignore */
      }
      input.pause();
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new AuthError("unauthenticated", "ввод токена прерван"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    input.on("data", onData);
  });
}

/** @param {NodeJS.ReadStream} input @returns {Promise<string>} */
async function readAll(input) {
  let text = "";
  for await (const chunk of input) text += String(chunk);
  return text;
}
