// ywiki/lib/credentials.mjs
// Credential loading for the read-only Yandex Wiki CLI.
//
// Reuses the existing legacy credential (schema v2) that `the legacy CLI` and the
// `the legacy refresh helper` systemd timer already maintain. This module NEVER writes the
// credential file, never prints the token, and never passes it through argv.
//
// Security:
//   - token lives in process memory only;
//   - `redact()` is the single choke point for any string that may contain it.
//
// ENV overrides (file is NOT read when a token override is present):
//   WIKI_IAM_TOKEN / WIKI_ORGANIZATION_ID, then LEGACY_IAM_TOKEN /
//   LEGACY_ORGANIZATION_ID.
//
// Path override: LEGACY_CREDENTIALS (used by tests).

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** @typedef {"iam" | "oauth"} Scheme */
/**
 * @typedef {Object} Creds
 * @property {string} token
 * @property {Scheme} scheme
 * @property {string} org
 * @property {number} mtimeMs
 */

/** Credential/auth failure. `kind` follows the CLI error taxonomy. */
export class AuthError extends Error {
  /**
   * @param {"unavailable" | "denied"} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = "AuthError";
    this.kind = kind;
  }
}

/** @type {{ path: string, mtimeMs: number, creds: Creds } | null} */
let cache = null;

/** Drop the in-process cache (used by self-heal after a refresh). */
export function invalidate() {
  cache = null;
}

/** @returns {string} Credential file path (LEGACY_CREDENTIALS override or default). */
export function credentialPath() {
  return (
    process.env.LEGACY_CREDENTIALS ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "st", "legacy", "credentials.toml")
  );
}

/**
 * Minimal flat TOML reader. The credential file is machine-generated with a
 * fixed flat shape, so a full TOML parser is unnecessary (zero-dep).
 * @param {string} text
 * @returns {Record<string, string | number | boolean>}
 */
function parseToml(text) {
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\(["\\])/g, "$1");
    } else if (val === "true") {
      out[key] = true;
      continue;
    } else if (val === "false") {
      out[key] = false;
      continue;
    } else if (/^-?\d+$/.test(val)) {
      out[key] = Number(val);
      continue;
    }
    out[key] = val;
  }
  return out;
}

/**
 * @param {Partial<Creds>} c
 * @throws {AuthError}
 */
function validate(c) {
  if (!c.token || typeof c.token !== "string") throw new AuthError("unavailable", "пустой token в креденшеле");
  if (!c.org || typeof c.org !== "string") throw new AuthError("unavailable", "пустой organization_id в креденшеле");
  if (c.scheme === "iam" && !/^t1\.[A-Za-z0-9._-]{20,}$/.test(c.token)) {
    throw new AuthError("unavailable", "iam-токен не соответствует формату legacy (ожидается префикс t1)");
  }
}

/** @returns {string | undefined} First token override present in the environment. */
function envToken() {
  return process.env.WIKI_IAM_TOKEN || process.env.LEGACY_IAM_TOKEN || undefined;
}

/**
 * Resolve credentials. ENV wins; otherwise read + cache the file by mtime.
 * @returns {Creds}
 * @throws {AuthError}
 */
export function credentials() {
  const tok = envToken();
  if (tok) {
    const org = process.env.WIKI_ORGANIZATION_ID || process.env.LEGACY_ORGANIZATION_ID || "";
    const creds = { token: tok, scheme: /** @type {Scheme} */ ("iam"), org, mtimeMs: 0 };
    validate(creds);
    return creds;
  }

  const path = credentialPath();
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new AuthError("unavailable", `нет файла креденшела: ${path}`);
  }
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs) return cache.creds;

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new AuthError("unavailable", `не читается файл креденшела: ${path}`);
  }

  const d = parseToml(text);
  if (String(d.version) !== "2") {
    throw new AuthError("unavailable", `неподдерживаемая version=${String(d.version)} (ожидается 2) в ${path}`);
  }
  const scheme = String(d.scheme || "iam").toLowerCase();
  if (scheme !== "iam" && scheme !== "oauth") {
    throw new AuthError("unavailable", `неизвестный scheme=${String(d.scheme)} в ${path}`);
  }
  const creds = { token: String(d.token ?? ""), scheme: /** @type {Scheme} */ (scheme), org: String(d.organization_id ?? ""), mtimeMs: st.mtimeMs };
  validate(creds);
  cache = { path, mtimeMs: st.mtimeMs, creds };
  return creds;
}

/**
 * Build auth + organization headers. Scheme drives the Authorization keyword;
 * numeric organization id selects X-Org-Id over X-Cloud-Org-Id.
 * @param {Creds} c
 * @returns {Record<string, string>}
 */
export function authHeaders(c) {
  const orgHeader = /^\d+$/.test(String(c.org)) ? "X-Org-Id" : "X-Cloud-Org-Id";
  return {
    Authorization: `${c.scheme === "iam" ? "Bearer" : "OAuth"} ${c.token}`,
    [orgHeader]: String(c.org),
  };
}

/** @param {string} t @returns {string} Allowed token display: first 6 chars. */
function prefix(t) {
  return t.length <= 6 ? t : `${t.slice(0, 6)}…`;
}

/**
 * Remove any token-like material from a string. Never throws.
 * @param {unknown} s
 * @returns {string}
 */
export function redact(s) {
  let out = s == null ? "" : String(s);
  if (cache?.creds?.token) out = out.split(cache.creds.token).join(prefix(cache.creds.token));
  out = out.replace(/\b(?:t1\.|y0_|y0__)[A-Za-z0-9._-]{16,}/g, (m) => prefix(m));
  return out;
}
