// ywiki/lib/credentials.mjs
// Credential loading and storage for the Yandex Wiki CLI.
//
// ywiki owns its credential: ~/.config/ywiki/credentials.toml (schema v2).
//
// Security:
//   - token is read in-process only, never through argv;
//   - redact() is the single choke point for anything that may contain a token;
//   - writes are atomic (0600 in a 0700 directory) and never logged.
//
// ENV overrides (file is NOT read when a token override is present):
//   WIKI_IAM_TOKEN + WIKI_ORGANIZATION_ID  -> scheme=iam
//   WIKI_TOKEN     + WIKI_ORGANIZATION_ID  -> scheme=oauth
// Only WIKI_* variables are read; no other tool's env names are honoured.
//
// Path override: WIKI_CREDENTIALS (used by tests).

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** @typedef {"iam" | "oauth"} Scheme */
/** @typedef {{
 *   token: string,
 *   scheme: Scheme,
 *   org: string,
 *   mtimeMs: number,
 *   refreshToken?: string,
 *   expiresAt?: number,
 *   clientId?: string,
 *   tokenEndpoint?: string,
 * }} Creds */

/** @type {Creds | null} */
let cache = null;
/** @type {string | null} */
let cachePath = null;
/** @type {Set<string>} */
const secrets = new Set();

/** @param {string} token */
export function registerSecret(token) {
  if (typeof token === "string" && token.length > 8) secrets.add(token);
}

/** @param {string} t @returns {string} */
export function tokenPrefix(t) {
  return t.length <= 6 ? t : `${t.slice(0, 6)}…`;
}

/** @param {string} t @returns {string} */
function prefix(t) {
  return tokenPrefix(t);
}

/** @returns {string} */
export function credentialPath() {
  return (
    process.env.WIKI_CREDENTIALS ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ywiki", "credentials.toml")
  );
}

/** @returns {string} */
export function cacheDir() {
  return (
    process.env.WIKI_CACHE_DIR ||
    join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ywiki")
  );
}

/** @param {string} s @returns {string} */
function tomlString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Minimal flat TOML reader. The credential file is flat and machine-written.
 * @param {string} text
 * @returns {Record<string, string | number>}
 */
function parseToml(text) {
  /** @type {Record<string, string | number>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      out[key] = value;
    } else if (/^-?\d+$/.test(value)) {
      out[key] = Number(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** @param {unknown} v @returns {string} */
function str(v) {
  return v == null ? "" : String(v);
}

/**
 * @param {Creds} c
 * @returns {Creds}
 */
export function validate(c) {
  const token = str(c.token);
  if (!token) throw new AuthError("unauthenticated", "пустой token в креденшеле");
  if (token.length > 4096) throw new AuthError("unauthenticated", "token слишком длинный");
  if (/[\r\n]/.test(token)) throw new AuthError("unauthenticated", "token содержит перевод строки");
  const org = str(c.org);
  if (!org) throw new AuthError("unauthenticated", "пустой organization_id в креденшеле");
  if (/[\s\p{Cc}]/u.test(org)) throw new AuthError("unauthenticated", "organization_id содержит пробелы или управляющие символы");
  const scheme = str(c.scheme).toLowerCase();
  if (scheme !== "iam" && scheme !== "oauth") {
    throw new AuthError("unauthenticated", `неизвестный scheme=${scheme || "(пусто)"} (ожидается iam или oauth)`);
  }
  if (scheme === "iam" && !/^t1\.[A-Za-z0-9._-]{20,}$/.test(token)) {
    throw new AuthError("unauthenticated", "IAM token не соответствует формату t1.…");
  }
  if (c.refreshToken != null && /[\r\n]/.test(str(c.refreshToken))) {
    throw new AuthError("unauthenticated", "refresh_token содержит перевод строки");
  }
  if (c.expiresAt != null && !Number.isFinite(Number(c.expiresAt))) {
    throw new AuthError("unauthenticated", "expires_at должен быть числом");
  }
  return { ...c, token, org, scheme: /** @type {Scheme} */ (scheme) };
}

/** @returns {Creds | null} */
export function envCredentials() {
  const iam = process.env.WIKI_IAM_TOKEN;
  const oauth = process.env.WIKI_TOKEN;
  const token = iam || oauth;
  if (!token) return null;
  const creds = {
    token,
    scheme: /** @type {Scheme} */ (iam ? "iam" : "oauth"),
    org: process.env.WIKI_ORGANIZATION_ID || "",
    mtimeMs: 0,
  };
  registerSecret(token);
  return validate(creds);
}

/** @returns {boolean} */
export function hasEnvCredential() {
  return Boolean(process.env.WIKI_IAM_TOKEN || process.env.WIKI_TOKEN);
}

/**
 * Read the credential file without throwing when it is absent.
 * @returns {Creds | null}
 */
export function readCredentialFile() {
  const path = credentialPath();
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (cache && cachePath === path && cache.mtimeMs === st.mtimeMs) return cache;

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const d = parseToml(text);
  if (String(d.version) !== "2") {
    throw new AuthError("unauthenticated", `неподдерживаемая version=${String(d.version)} (ожидается 2) в ${path}`);
  }
  const creds = validate({
    token: str(d.token),
    scheme: /** @type {Scheme} */ (str(d.scheme || "iam").toLowerCase()),
    org: str(d.organization_id),
    mtimeMs: st.mtimeMs,
    refreshToken: d.refresh_token ? str(d.refresh_token) : undefined,
    expiresAt: d.expires_at != null ? Number(d.expires_at) : undefined,
    clientId: d.client_id ? str(d.client_id) : undefined,
    tokenEndpoint: d.token_endpoint ? str(d.token_endpoint) : undefined,
  });
  registerSecret(creds.token);
  if (creds.refreshToken) registerSecret(creds.refreshToken);
  cache = creds;
  cachePath = path;
  return creds;
}

/**
 * @returns {Creds}
 * @throws {AuthError}
 */
export function credentials() {
  const env = envCredentials();
  if (env) return env;
  const creds = readCredentialFile();
  if (!creds) {
    throw new AuthError(
      "unauthenticated",
      `креденшел не найден: ${credentialPath()}. Выполните: ywiki auth login`,
    );
  }
  return creds;
}

/**
 * Atomically write the credential file (0600 in a 0700 directory).
 * @param {Creds} c
 * @returns {Creds}
 */
export function writeCredential(c) {
  const creds = validate({ ...c, mtimeMs: Date.now() });
  const path = credentialPath();
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort on dir mode */
  }

  const lines = [
    "version = 2",
    `token = "${tomlString(creds.token)}"`,
    `scheme = "${tomlString(creds.scheme)}"`,
    `organization_id = "${tomlString(creds.org)}"`,
  ];
  if (creds.refreshToken) lines.push(`refresh_token = "${tomlString(creds.refreshToken)}"`);
  if (creds.expiresAt != null) lines.push(`expires_at = ${Number(creds.expiresAt)}`);
  if (creds.clientId) lines.push(`client_id = "${tomlString(creds.clientId)}"`);
  if (creds.tokenEndpoint) lines.push(`token_endpoint = "${tomlString(creds.tokenEndpoint)}"`);
  const text = `${lines.join("\n")}\n`;

  const tmp = join(dir, `.credentials.toml.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`);
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }

  registerSecret(creds.token);
  if (creds.refreshToken) registerSecret(creds.refreshToken);
  invalidate();
  return creds;
}

/**
 * Delete the local credential file. Returns true when a file was removed.
 * @returns {boolean}
 */
export function removeCredential() {
  try {
    unlinkSync(credentialPath());
    invalidate();
    return true;
  } catch (e) {
    if (e && /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return false;
    throw e;
  }
}

/** Clear the in-process credential cache. */
export function invalidate() {
  cache = null;
  cachePath = null;
}

/**
 * Build auth + organization headers. Scheme drives the Authorization keyword;
 * numeric organization id selects X-Org-Id over X-Cloud-Org-Id.
 * @param {Creds} c
 * @returns {Record<string, string>}
 */
export function authHeaders(c) {
  const orgHeader = /^\d+$/.test(str(c.org)) ? "X-Org-Id" : "X-Cloud-Org-Id";
  return {
    Authorization: `${c.scheme === "iam" ? "Bearer" : "OAuth"} ${c.token}`,
    [orgHeader]: str(c.org),
  };
}

/**
 * Remove any token-like material from a string. Never throws.
 * @param {unknown} s
 * @returns {string}
 */
export function redact(s) {
  let out = s == null ? "" : String(s);
  for (const secret of secrets) out = out.split(secret).join(prefix(secret));
  out = out.replace(/\b(?:t1\.|y0_{1,2})[A-Za-z0-9._-]{16,}/g, (m) => prefix(m));
  return out;
}

/** Auth error with the CLI error taxonomy kind. */
export class AuthError extends Error {
  /**
   * @param {"unauthenticated" | "unavailable"} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = "AuthError";
    this.kind = kind;
  }
}
