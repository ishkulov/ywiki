// ywiki/tests/inline.test.mjs
// Unit tests for the pure inline helpers: ranges, markers and `page locate`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  toChars,
  parseRange,
  scanMarkers,
  validateRange,
  insertMarker,
  removeMarkers,
  locateText,
} from "../lib/inline.mjs";
import { buildCommentBody, commentQuery, threadQuery } from "../lib/comments.mjs";

test("parseRange accepts START-END and rejects bad shapes", () => {
  assert.deepEqual(parseRange("42-54"), { start: 42, end: 54 });
  assert.deepEqual(parseRange(" 0 - 3 "), { start: 0, end: 3 });
  for (const bad of ["", "12", "12-12", "12-11", "a-b", "-1-2", "1-2-3"]) {
    assert.throws(() => parseRange(bad), /--inline-range/, `must reject ${JSON.stringify(bad)}`);
  }
});

test("scanMarkers finds &[text](id) in code-point space", () => {
  const chars = toChars("до &[фрагмент](123) после &[ещё](7)");
  const markers = scanMarkers(chars);
  assert.equal(markers.length, 2);
  assert.deepEqual(
    markers.map((m) => ({ text: m.text, id: m.id })),
    [
      { text: "фрагмент", id: 123 },
      { text: "ещё", id: 7 },
    ],
  );
  assert.equal(chars.slice(markers[0].start, markers[0].end).join(""), "&[фрагмент](123)");
});

test("validateRange rejects bounds, newlines, marker syntax and overlaps", () => {
  const chars = toChars("до &[фрагмент](123) после");
  const markers = scanMarkers(chars);
  assert.equal(validateRange(chars, { start: 0, end: 2 }, markers), "до");
  assert.throws(() => validateRange(chars, { start: 5, end: 2 }, markers), /START/);
  assert.throws(() => validateRange(chars, { start: 0, end: 999 }, markers), /вне текста/);
  const multiline = toChars("a\nb");
  assert.throws(() => validateRange(multiline, { start: 0, end: 3 }, []), /перевод строки/);
  const bracket = toChars("a]b");
  assert.throws(() => validateRange(bracket, { start: 1, end: 2 }, []), /\]/);
  const overlap = scanMarkers(toChars("&[x](1)"));
  assert.throws(() => validateRange(toChars("&[x](1)"), { start: 0, end: 2 }, overlap), /пересекает/);
});

test("insertMarker wraps the range and keeps the text", () => {
  const chars = toChars("до фрагмент после");
  const r = insertMarker(chars, { start: 3, end: 11 }, 42);
  assert.equal(r.marker, "&[фрагмент](42)");
  assert.equal(r.content, "до &[фрагмент](42) после");
});

test("removeMarkers removes every marker with the id and keeps its text", () => {
  const chars = toChars("a &[x](1) b &[x](1) c");
  const r = removeMarkers(chars, 1);
  assert.equal(r.removed, true);
  assert.equal(r.content, "a x b x c");
  const none = removeMarkers(toChars("a b"), 9);
  assert.equal(none.removed, false);
  assert.equal(none.content, "a b");
});

test("locateText returns code-point ranges, line/column and marker overlap", () => {
  const chars = toChars("Первый абзац.\n&[Второй](7) абзац.");
  const markers = scanMarkers(chars);
  const { total, occurrences } = locateText(chars, "абзац", { markers });
  assert.equal(total, 2);
  assert.equal(occurrences.length, 2);
  assert.deepEqual(
    occurrences.map((o) => ({ start: o.start, end: o.end, line: o.line, column: o.column, inside: o.inside_marker })),
    [
      { start: 7, end: 12, line: 1, column: 8, inside: false },
      { start: 27, end: 32, line: 2, column: 14, inside: false },
    ],
  );
  const inside = locateText(chars, "Второй", { markers });
  assert.equal(inside.occurrences[0].inside_marker, true);
});

test("locateText counts code points, not UTF-16 units", () => {
  const chars = toChars("🙂 x");
  const { occurrences } = locateText(chars, "x");
  assert.equal(occurrences[0].start, 2);
  assert.equal(occurrences[0].end, 3);
  assert.equal(occurrences[0].column, 3);
});

test("locateText truncates to --limit but reports the full count", () => {
  const { total, occurrences } = locateText(toChars("aaaa"), "a", { limit: 2 });
  assert.equal(total, 4);
  assert.equal(occurrences.length, 2);
});

test("buildCommentBody keeps only provided fields", () => {
  assert.deepEqual(buildCommentBody({ body: "text" }), { body: "text" });
  assert.deepEqual(buildCommentBody({ body: "text", inlineText: "frag", parentId: 1, threadId: 2 }), {
    body: "text",
    inline_text: "frag",
    parent_id: 1,
    thread_id: 2,
  });
  assert.throws(() => buildCommentBody({ body: "   " }), /body|комментарий/);
});

test("commentQuery and threadQuery build the documented parameters", () => {
  assert.equal(commentQuery({}), "");
  assert.equal(commentQuery({ limit: 5 }), "");
  assert.equal(commentQuery({ pageSize: 5, cursor: "c2", status: "unresolved", order: "asc" }), "?page_size=5&cursor=c2&status_filter=unresolved&order_by=created_at&order_direction=asc");
  assert.equal(threadQuery({ pageSize: 5, cursor: "c2" }), "?page_size=5&cursor=c2");
});
