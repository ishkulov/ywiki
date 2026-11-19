// ywiki/lib/output.mjs
// Shared output helpers: exit codes, the typed error, clipping, help text, the
// stderr error envelope, and the TTY-aware emitter.
//
// Terminology and exit codes mirror the `the legacy CLI` CLI so that agents and
// scripts can treat both tools the same way.
//
// No I/O side effects beyond writing to stdout/stderr in `emit`.

/** Process exit codes (aligned with `the legacy CLI`). */
export const EXIT = Object.freeze({
  ok: 0,
  usage: 2,
  unauthenticated: 3,
  access_denied: 4,
  not_found: 5,
  conflict: 6,
  unavailable: 8,
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

export const VERSION = "0.2.1";

// ---------------------------------------------------------------------------
// Output mode (aligned with `the legacy CLI`): JSON is the default whenever stdout is
// not a terminal (agents, pipes, CI); rich human text is the default on a TTY.
// `--json` forces JSON, `--rich-ui=yes|no` overrides both ways.
// ---------------------------------------------------------------------------

/**
 * Decide the output mode.
 * @param {{ json?: boolean, richUi?: string }} [opts]
 * @returns {boolean} true → JSON, false → rich human text
 */
export function wantJson(opts = {}) {
  if (opts.json) return true;
  if (opts.richUi === "yes") return false;
  if (opts.richUi === "no") return true;
  return !process.stdout.isTTY;
}

/**
 * Print a result: JSON payload or rendered human text.
 * @param {unknown} value JSON payload
 * @param {(v: any) => string} human human renderer
 * @param {{ json?: boolean, richUi?: string }} [opts]
 */
export function emit(value, human, opts = {}) {
  if (wantJson(opts)) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  const text = String(human(value) ?? "");
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

// ---------------------------------------------------------------------------
// Error envelope (mirrors `the legacy CLI`):
//   Error: <Title>
//     <detail>
//     Next: <action>
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const ERROR_TITLE = {
  usage: "Invalid command usage",
  unauthenticated: "Wiki authentication is required",
  access_denied: "Access denied",
  not_found: "Requested resource was not found",
  conflict: "Conflict",
  unavailable: "Service unavailable",
};

/** @type {Record<string, string>} */
const ERROR_NEXT = {
  usage: "Review the command help (`ywiki --help`) and try again.",
  unauthenticated: "Refresh the credential: `the legacy refresh helper --refresh` (or task opencode:the legacy CLI-refresh).",
  access_denied: "You do not have access to this resource; do not retry — ask the page owner.",
  not_found: "Check the slug with `ywiki search`.",
  conflict: "The search index is warming up; retry shortly.",
  unavailable: "Transient failure; retry later.",
};

/**
 * Build a three-line error envelope. `detail` must already be redacted.
 * @param {string} kind
 * @param {unknown} detail
 * @returns {string}
 */
export function errorEnvelope(kind, detail) {
  const title = ERROR_TITLE[kind] || "Error";
  const next = ERROR_NEXT[kind] || "Retry later.";
  const lines = [`Error: ${title}`];
  const d = String(detail ?? "").replace(/\s+/g, " ").trim();
  if (d) lines.push(`  ${d}`);
  lines.push(`  Next: ${next}`);
  return lines.join("\n") + "\n";
}

/** Full `--help` text (kept ≤ 25 lines). JSON is the default when piped. */
export function usageText() {
  return [
    "ywiki — read-only CLI for Yandex Wiki",
    "$ ywiki search 'регламент релиза'   find a page, then read it by slug",
    "",
    "Usage",
    "  ywiki <command>",
    "",
    "Commands",
    "  whoami                  Show the current identity and credential",
    "  page get <slug>         Read a page (--offset N --limit N --fields a,b)",
    "  page search <query>     Full-text search (--limit N --all --cursor N)",
    "  page descendants <slug> List sub-pages (--limit N --all --cursor N)",
    "  page comments <slug>    List page comments (--limit N --all)",
    "  space list              List spaces (--all)",
    "  api GET <path>          Call a read-only API path",
    "  skill                   Print bundled agent guidance",
    "",
    "Shortcuts",
    "  get <slug> · search <query> · tree <slug> · spaces",
    "",
    "Options",
    "  -h, --help · -v, --version · --json · --rich-ui=yes|no · --no-cache",
    "",
    "Exit: 0 ok · 2 usage · 3 auth · 4 access · 5 not_found · 6 conflict · 8 unavailable",
  ].join("\n");
}

/** Per-command help, keyed by canonical command path. */
export const COMMAND_HELP = Object.freeze({
  whoami: "ywiki whoami [--json]\n  Show the current identity and credential.",
  "page get": "ywiki page get <slug> [--offset N] [--limit N] [--fields a,b]\n  Read a Wiki page by slug.",
  get: "ywiki get <slug> [--offset N] [--limit N] [--fields a,b]\n  Read a Wiki page by slug.",
  "page search": "ywiki page search <query> [--limit N] [--all] [--cursor N]\n  Full-text search over pages.",
  search: "ywiki search <query> [--limit N] [--all] [--cursor N]\n  Full-text search over pages.",
  "page descendants": "ywiki page descendants <slug> [--limit N] [--all] [--cursor N]\n  List sub-pages of a slug.",
  "page comments": "ywiki page comments <slug> [--limit N] [--all]\n  List top-level comments for a page (resolved by slug).",
  tree: "ywiki tree <slug> [--limit N] [--all] [--cursor N]\n  List sub-pages of a slug.",
  "space list": "ywiki space list [--all]\n  List spaces visible to the user.",
  spaces: "ywiki spaces [--all]\n  List spaces visible to the user.",
  api: "ywiki api GET <path> [--header \"Name: value\"]\n  Call a read-only (GET) API path under /v1.",
  skill: "ywiki skill\n  Print bundled agent guidance.",
});

/** Bundled agent guidance, mirroring `the legacy CLI skill`. */
export function skillText() {
  return [
    "---",
    "name: ywiki-cli",
    "description: Use for Yandex Wiki pages — search, read a page, list sub-pages, list comments, list spaces.",
    "---",
    "",
    "Run `ywiki` (network required). Help: `-h` appended to any command.",
    "",
    "Output is JSON when piped (default for agents); `--rich-ui=yes` forces text.",
    "Exit 4 is a confirmed denial — do not retry; every other failure prints its own cause.",
    "",
    "```sh",
    "# Resolve a slug with search, then read the page.",
    "ywiki search 'регламент релиза' --limit 20",
    "ywiki page get team/release --fields content,attributes",
    "ywiki page get team/release --offset 12000      # continue a long page",
    "ywiki page descendants team                     # walk the tree",
    "ywiki page comments team/release               # list comments",
    "ywiki space list",
    "ywiki api GET pages?slug=team/release&fields=title",
    "```",
    "",
    "Resolve every slug with `ywiki search` before reading, then cite the slug you used.",
  ].join("\n");
}
