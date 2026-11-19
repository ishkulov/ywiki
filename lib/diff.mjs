// ywiki/lib/diff.mjs
// Pure, zero-dependency line diff for the read-only `page diff` command.
// No network and no filesystem here.
//
// The Wiki API has no diff endpoint, so `ywiki` compares two revisions
// locally: an LCS table for normal pages and a prefix/suffix fallback for very
// large ones (bounded memory).

export const DIFF_CONTEXT_MAX = 50;
export const DIFF_CELL_BUDGET = 4_000_000;

/**
 * Split content into lines. `\r\n` is normalised and a single trailing
 * newline does not produce a phantom empty line.
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  const s = String(text ?? "").replace(/\r\n/g, "\n");
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Prefix/suffix diff: identical head and tail stay equal, the middle is
 * replaced. Used when the LCS table would exceed the cell budget.
 * @param {string[]} left
 * @param {string[]} right
 */
function coarseOps(left, right) {
  const max = Math.min(left.length, right.length);
  let head = 0;
  while (head < max && left[head] === right[head]) head++;
  let tail = 0;
  while (
    tail < max - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail++;
  }
  const ops = [];
  for (let i = 0; i < head; i++) ops.push({ type: "eq", text: left[i] });
  for (let i = head; i < left.length - tail; i++) ops.push({ type: "del", text: left[i] });
  for (let i = head; i < right.length - tail; i++) ops.push({ type: "add", text: right[i] });
  for (let i = left.length - tail; i < left.length; i++) ops.push({ type: "eq", text: left[i] });
  return ops;
}

/**
 * Line-level ops (`eq` / `del` / `add`) for two line arrays.
 * @param {string[]} left
 * @param {string[]} right
 * @returns {{ ops: Array<{ type: "eq"|"del"|"add", text: string }>, coarse: boolean }}
 */
export function diffLines(left, right) {
  const n = left.length;
  const m = right.length;
  if ((n + 1) * (m + 1) > DIFF_CELL_BUDGET) {
    return { ops: coarseOps(left, right), coarse: true };
  }

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w;
    const next = (i + 1) * w;
    const line = left[i];
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] =
        line === right[j]
          ? dp[next + j + 1] + 1
          : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      ops.push({ type: "eq", text: left[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ type: "del", text: left[i] });
      i++;
    } else {
      ops.push({ type: "add", text: right[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: left[i++] });
  while (j < m) ops.push({ type: "add", text: right[j++] });
  return { ops, coarse: false };
}

/** `start` or `start,count` as unified-diff ranges do it. */
function range(start, count) {
  return count === 1 ? String(start) : `${start},${count}`;
}

/**
 * Group ops into hunks with `context` unchanged lines around each change.
 * Hunks merge when the unchanged gap between them is at most `2 * context`.
 * @param {Array<{type:string,text:string}>} ops
 * @param {number} context
 */
export function buildHunks(ops, context = 3) {
  const n = ops.length;
  const changes = [];
  for (let i = 0; i < n; i++) if (ops[i].type !== "eq") changes.push(i);
  if (!changes.length) return [];

  const oldAt = new Uint32Array(n + 1);
  const newAt = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    oldAt[i + 1] = oldAt[i] + (ops[i].type === "add" ? 0 : 1);
    newAt[i + 1] = newAt[i] + (ops[i].type === "del" ? 0 : 1);
  }

  /** @type {Array<{ first: number, last: number }>} */
  const groups = [];
  let first = changes[0];
  let last = changes[0];
  for (let k = 1; k < changes.length; k++) {
    const c = changes[k];
    if (c - last - 1 > 2 * context) {
      groups.push({ first, last });
      first = c;
    }
    last = c;
  }
  groups.push({ first, last });

  return groups.map(({ first, last }) => {
    const lo = Math.max(0, first - context);
    const hi = Math.min(n - 1, last + context);
    const slice = ops.slice(lo, hi + 1);
    const oldCount = oldAt[hi + 1] - oldAt[lo];
    const newCount = newAt[hi + 1] - newAt[lo];
    const oldBefore = oldAt[lo];
    const newBefore = newAt[lo];
    const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1;
    const newStart = newCount === 0 ? newBefore : newBefore + 1;
    const lines = slice.map((op) => {
      const prefix = op.type === "eq" ? " " : op.type === "del" ? "-" : "+";
      return prefix + op.text;
    });
    return {
      header: `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`,
      lines,
    };
  });
}

/**
 * Unified diff of two texts.
 * @param {string} leftText
 * @param {string} rightText
 * @param {{ context?: number, labelFrom?: string, labelTo?: string }} [opts]
 * @returns {{ patch: string, changed: boolean, added: number, removed: number, hunks: number, coarse: boolean }}
 */
export function unifiedDiff(leftText, rightText, opts = {}) {
  const context = opts.context ?? 3;
  const { ops, coarse } = diffLines(splitLines(leftText), splitLines(rightText));

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }
  const changed = added > 0 || removed > 0;
  const hunks = changed ? buildHunks(ops, context) : [];

  const out = [];
  if (changed) {
    out.push(`--- ${opts.labelFrom ?? "from"}`);
    out.push(`+++ ${opts.labelTo ?? "to"}`);
    for (const hunk of hunks) {
      out.push(hunk.header);
      out.push(...hunk.lines);
    }
  }
  return { patch: out.join("\n"), changed, added, removed, hunks: hunks.length, coarse };
}
