// ywiki/lib/output.mjs
// Shared output helpers: exit codes, the typed error, clipping, and usage text.
// No I/O side effects beyond returning strings.

/** Process exit codes (semantics aligned with `the legacy CLI`). */
export const EXIT = Object.freeze({
  ok: 0,
  usage: 2,
  not_found: 3,
  access_denied: 4,
  upstream_unavailable: 5,
  auth_unavailable: 8,
});

/**
 * Typed CLI error. `kind` maps to an exit code via EXIT.
 */
export class WikiError extends Error {
  /**
   * @param {keyof typeof EXIT} kind
   * @param {string} message
   * @param {{ status?: number }} [meta]
   */
  constructor(kind, message, meta = {}) {
    super(message);
    this.name = "WikiError";
    this.kind = kind;
    this.status = meta.status;
  }
}

/** @param {unknown} e @returns {number} */
export function exitCodeFor(e) {
  if (e instanceof WikiError) return EXIT[e.kind];
  if (e && typeof e === "object" && "kind" in e && e.kind === "unavailable") return EXIT.auth_unavailable;
  return EXIT.upstream_unavailable;
}

export const DEFAULT_LIMIT = 12000;

/**
 * Clip `text` to a window starting at `offset` (characters).
 * @param {string} text
 * @param {number} [offset]
 * @param {number} [limit]
 * @returns {{ text: string, truncated: boolean, nextOffset: number, total: number, start: number }}
 */
export function clip(text, offset = 0, limit = DEFAULT_LIMIT) {
  const s = typeof text === "string" ? text : String(text ?? "");
  const total = s.length;
  const start = Math.max(0, Math.trunc(offset) || 0);
  const size = Math.max(1, Math.trunc(limit) || DEFAULT_LIMIT);
  const slice = s.slice(start, start + size);
  const truncated = start + size < total;
  return { text: slice, truncated, nextOffset: start + size, total, start };
}

/**
 * Human continuation hint for a truncated clip, or "" when complete.
 * @param {ReturnType<typeof clip>} c
 */
export function clipHint(c) {
  if (!c.truncated) return "";
  return `… [обрезано; всего ${c.total} символов] продолжение: --offset ${c.nextOffset}`;
}

export const VERSION = "0.1.0";

/** Full help text (kept ≤ 25 lines). */
export function usageText() {
  return [
    "ywiki — чтение Yandex Wiki (read-only)",
    "",
    "Использование:",
    "  ywiki whoami                       кто я, схема, org, возраст креденшела",
    "  ywiki get <slug>                   страница по слагу (--offset N --limit N)",
    "  ywiki search <query>               полнотекстовый поиск (--limit N)",
    "  ywiki tree <slug>                  подстраницы (--limit N)",
    "  ywiki spaces                       список пространств",
    "  ywiki --help | --version",
    "",
    "Глобально: --json  --no-cache  --timeout S",
    "",
    "Примеры:",
    "  ywiki search 'регламент релиза'",
    "  ywiki get team/release --offset 12000",
    "",
    "Коды: 0 ok · 2 usage · 3 not_found · 4 access_denied · 5 upstream · 8 auth",
    "Refresh токена: task opencode:the legacy CLI-refresh",
  ].join("\n");
}

/**
 * One-line usage hint appended to errors.
 * @param {string} [hint]
 */
export function errorHint(hint) {
  return `${hint || "см. ywiki --help"}`;
}
