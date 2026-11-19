// ywiki/lib/inline.mjs
// Pure helpers for inline comments: text ranges, `&[text](id)` markers and
// `page locate`. No network and no filesystem here.
//
// Offsets are counted in Unicode code points (not UTF-16 units) so a range
// means the same thing to a person, to Python/Go and to this CLI. A range is
// 0-based and end-exclusive: `0-6` covers the first six characters.

import { UsageError } from "./output.mjs";

/**
 * Split content into code points. Every helper in this module works on this
 * array, so offsets never drift on emoji or other surrogate pairs.
 * @param {string} content
 * @returns {string[]}
 */
export function toChars(content) {
  return Array.from(String(content ?? ""));
}

/**
 * Parse an `--inline-range` value: `START-END`, 0-based, end-exclusive.
 * @param {string} spec
 * @returns {{ start: number, end: number }}
 */
export function parseRange(spec) {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(spec ?? "").trim());
  if (!m) throw new UsageError("--inline-range: ожидается START-END (например, 42-54)");
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new UsageError("--inline-range: START и END должны быть целыми");
  }
  if (start >= end) throw new UsageError("--inline-range: START должен быть меньше END");
  return { start, end };
}

/**
 * Find `&[text](id)` markers in code-point space. `start`/`end` cover the whole
 * marker; `text` is the anchored fragment.
 * @param {string[]} chars
 * @returns {{ start: number, end: number, text: string, id: number }[]}
 */
export function scanMarkers(chars) {
  const markers = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "&" || chars[i + 1] !== "[") continue;
    let j = i + 2;
    let text = "";
    while (j < chars.length && chars[j] !== "]") {
      text += chars[j];
      j++;
    }
    if (j >= chars.length || chars[j] !== "]" || chars[j + 1] !== "(") continue;
    let k = j + 2;
    let id = "";
    while (k < chars.length && /[0-9]/.test(chars[k])) {
      id += chars[k];
      k++;
    }
    if (!id || chars[k] !== ")") continue;
    markers.push({ start: i, end: k + 1, text, id: Number(id) });
    i = k;
  }
  return markers;
}

/**
 * Validate a range against the page text and existing markers. Returns the
 * anchored text so the caller can send it as `inline_text`.
 * @param {string[]} chars
 * @param {{ start: number, end: number }} range
 * @param {ReturnType<typeof scanMarkers>} [markers]
 * @returns {string}
 */
export function validateRange(chars, range, markers = scanMarkers(chars)) {
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new UsageError("--inline-range: START и END должны быть целыми");
  }
  if (start < 0 || end > chars.length) {
    throw new UsageError(`--inline-range: диапазон ${start}-${end} вне текста (0-${chars.length})`);
  }
  if (start >= end) throw new UsageError("--inline-range: START должен быть меньше END");
  const text = chars.slice(start, end).join("");
  if (!text) throw new UsageError("--inline-range: диапазон пуст");
  if (text.includes("\n") || text.includes("\r")) {
    throw new UsageError("--inline-range: диапазон не должен пересекать перевод строки");
  }
  if (text.includes("]") || text.includes(")")) {
    throw new UsageError("--inline-range: фрагмент содержит `]` или `)`, маркер сломается");
  }
  for (const m of markers) {
    if (start < m.end && end > m.start) {
      throw new UsageError(
        `--inline-range: диапазон ${start}-${end} пересекает маркер комментария #${m.id} (${m.start}-${m.end})`,
      );
    }
  }
  return text;
}

/**
 * Wrap a range in `&[text](id)` without removing the original text.
 * @param {string[]} chars
 * @param {{ start: number, end: number }} range
 * @param {number} id
 * @returns {{ content: string, marker: string, text: string }}
 */
export function insertMarker(chars, range, id) {
  const text = chars.slice(range.start, range.end).join("");
  const marker = `&[${text}](${id})`;
  const content =
    chars.slice(0, range.start).join("") + marker + chars.slice(range.end).join("");
  return { content, marker, text };
}

/**
 * Remove every marker with `id`, keeping the anchored text in place. Re-scans
 * after each removal because indices shift.
 * @param {string[]} chars
 * @param {number} id
 * @returns {{ content: string, removed: boolean, marker: { start: number, end: number, text: string, id: number } | null }}
 */
export function removeMarkers(chars, id) {
  let content = chars.join("");
  let removed = false;
  let marker = null;
  for (;;) {
    const arr = toChars(content);
    const found = scanMarkers(arr).find((m) => m.id === id);
    if (!found) break;
    content = arr.slice(0, found.start).join("") + found.text + arr.slice(found.end).join("");
    removed = true;
    marker = found;
  }
  return { content, removed, marker };
}

/**
 * Locate every occurrence of `query` in code-point space. Overlapping matches
 * are reported; the caller decides which one to use.
 * @param {string[]} chars
 * @param {string} query
 * @param {{ limit?: number, markers?: ReturnType<typeof scanMarkers> }} [opts]
 * @returns {{ total: number, occurrences: { start: number, end: number, line: number, column: number, inside_marker: boolean, context: string }[] }}
 */
export function locateText(chars, query, opts = {}) {
  const needle = toChars(query);
  if (!needle.length) throw new UsageError("page locate: укажите непустой текст");
  const limit = opts.limit === undefined ? 20 : opts.limit;
  const markers = opts.markers ?? scanMarkers(chars);

  // Line starts in code-point space; `line` is 1-based.
  const lineStarts = [0];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: pos - lineStarts[lo] + 1 };
  };

  const occurrences = [];
  let total = 0;
  for (let i = 0; i + needle.length <= chars.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (chars[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    total++;
    if (occurrences.length >= limit) continue;
    const start = i;
    const end = i + needle.length;
    const { line, column } = lineOf(start);
    const inside = markers.some((m) => start < m.end && end > m.start);
    const from = Math.max(0, start - 40);
    const to = Math.min(chars.length, end + 40);
    const context = chars.slice(from, to).join("").replace(/\r?\n/g, "↵");
    occurrences.push({ start, end, line, column, inside_marker: inside, context });
  }
  return { total, occurrences };
}
