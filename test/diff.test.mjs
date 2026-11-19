// ywiki/test/diff.test.mjs
// Tests for `page diff`: pure helpers (`lib/diff.mjs`) plus end-to-end CLI
// behaviour against a local stub HTTP server.
//
// No real network. Credentials come from ENV; the cache is a tmp dir. The stub
// runs in-process, so children are spawned ASYNC to keep the event loop free.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { splitLines, diffLines, buildHunks, unifiedDiff, DIFF_CELL_BUDGET } from "../lib/diff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ywiki.mjs");

const IAM_PREFIX = ["t", "1", "."].join("");
const IAM = IAM_PREFIX + "B".repeat(40);

const LEFT = "alpha\nbeta\ngamma\n";
const RIGHT = "alpha\nBETA\ngamma\ndelta\n";
const SAME = "alpha\nbeta\ngamma\n";

/** @type {import("node:http").Server} */
let server;
let baseUrl;
let cacheDir;
/** @type {Array<{method:string,url:string}>} */
let seen = [];

function meta(id, username, createdAt) {
  return {
    id,
    author: { username, display_name: username.toUpperCase() },
    created_at: createdAt,
    page_type: "wysiwyg",
    revision_draft: null,
    publication: null,
  };
}

before(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "ywiki-diff-cache-"));
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    seen.push({ method: req.method, url: req.url });
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "GET" && url.pathname === "/v1/pages") {
        const slug = url.searchParams.get("slug");
        const rev = Number(url.searchParams.get("revision_id"));
        if (rev === 999) return send(404, { error_code: "NOT_FOUND" });
        if (rev === 111 || rev === 333) {
          return send(200, {
            id: 42,
            slug,
            title: "Заголовок",
            page_type: "wysiwyg",
            last_revision_id: 222,
            active_revision: meta(rev, rev === 111 ? "alice" : "carol", "2026-07-27T10:00:00Z"),
            content: rev === 111 ? LEFT : SAME,
          });
        }
        if (rev === 222) {
          return send(200, {
            id: 42,
            slug,
            title: "Заголовок",
            page_type: "wysiwyg",
            last_revision_id: 222,
            active_revision: meta(222, "bob", "2026-07-28T10:00:00Z"),
            content: RIGHT,
          });
        }
        return send(200, { id: 42, slug, title: "Заголовок", page_type: "wysiwyg", last_revision_id: 222 });
      }
      return send(404, { error_code: "NOT_FOUND" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => {
  server.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

/**
 * @param {string[]} args
 * @returns {Promise<{status:number, stdout:string, stderr:string}>}
 */
function run(args) {
  const env = {
    ...process.env,
    WIKI_BASE_URL: baseUrl,
    WIKI_IAM_TOKEN: IAM,
    WIKI_ORGANIZATION_ID: "orgTEST",
    WIKI_CACHE_DIR: cacheDir,
  };
  delete env.LEGACY_CREDENTIALS;
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { encoding: "utf8", env }, (err, stdout, stderr) => {
      resolve({ status: err && typeof err.code === "number" ? err.code : 0, stdout, stderr });
    });
  });
}

const LABELS = { labelFrom: "team/reg revision 111", labelTo: "team/reg revision 222" };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("splitLines normalises line endings and drops one trailing newline", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("a"), ["a"]);
  assert.deepEqual(splitLines("a\n"), ["a"]);
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
});

test("diffLines reports equal, removed and added lines", () => {
  const { ops, coarse } = diffLines(["a", "b", "c"], ["a", "B", "c"]);
  assert.equal(coarse, false);
  assert.deepEqual(
    ops.map((o) => `${o.type}:${o.text}`),
    ["eq:a", "del:b", "add:B", "eq:c"],
  );
});

test("diffLines handles pure insertions and deletions", () => {
  assert.deepEqual(
    diffLines(["a", "c"], ["a", "b", "c"]).ops.map((o) => `${o.type}:${o.text}`),
    ["eq:a", "add:b", "eq:c"],
  );
  assert.deepEqual(
    diffLines(["a", "b", "c"], ["a", "c"]).ops.map((o) => `${o.type}:${o.text}`),
    ["eq:a", "del:b", "eq:c"],
  );
});

test("diffLines falls back to a coarse diff when the LCS table is too large", () => {
  const size = Math.ceil(Math.sqrt(DIFF_CELL_BUDGET)) + 1;
  const left = Array.from({ length: size }, (_, i) => `line ${i}`);
  const right = [...left];
  right[Math.floor(size / 2)] = "changed";
  const { ops, coarse } = diffLines(left, right);
  assert.equal(coarse, true);
  assert.equal(ops.filter((o) => o.type === "del").length, 1);
  assert.equal(ops.filter((o) => o.type === "add").length, 1);
});

test("buildHunks merges nearby changes and splits distant ones", () => {
  const ops = diffLines(["a", "b", "c", "d"], ["a", "B", "c", "D"]).ops;
  assert.equal(buildHunks(ops, 3).length, 1);
  assert.equal(buildHunks(ops, 0).length, 2);
});

test("unifiedDiff returns an empty patch for identical text", () => {
  assert.deepEqual(unifiedDiff("a\nb\n", "a\nb\n"), {
    patch: "",
    changed: false,
    added: 0,
    removed: 0,
    hunks: 0,
    coarse: false,
  });
});

test("unifiedDiff builds headers, hunks and counts", () => {
  const d = unifiedDiff(LEFT, RIGHT, LABELS);
  assert.equal(d.changed, true);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.equal(d.hunks, 1);
  assert.equal(d.coarse, false);
  assert.equal(
    d.patch,
    [
      "--- team/reg revision 111",
      "+++ team/reg revision 222",
      "@@ -1,3 +1,4 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "+delta",
    ].join("\n"),
  );
});

test("unifiedDiff --context 0 emits minimal hunks", () => {
  const d = unifiedDiff(LEFT, RIGHT, { ...LABELS, context: 0 });
  assert.equal(d.hunks, 2);
  assert.equal(
    d.patch,
    [
      "--- team/reg revision 111",
      "+++ team/reg revision 222",
      "@@ -2 +2 @@",
      "-beta",
      "+BETA",
      "@@ -3,0 +4 @@",
      "+delta",
    ].join("\n"),
  );
});

test("unifiedDiff uses -0,0 for an insertion into an empty file", () => {
  const d = unifiedDiff("", "first\n", { labelFrom: "empty", labelTo: "first" });
  assert.equal(
    d.patch,
    ["--- empty", "+++ first", "@@ -0,0 +1 @@", "+first"].join("\n"),
  );
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("page diff compares two revisions and prints JSON by default", async () => {
  const r = await run(["page", "diff", "team/reg", "111", "222"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.slug, "team/reg");
  assert.equal(j.id, 42);
  assert.equal(j.from_revision_id, 111);
  assert.equal(j.to_revision_id, 222);
  assert.equal(j.from.author, "alice");
  assert.equal(j.to.author, "bob");
  assert.equal(j.changed, true);
  assert.equal(j.added, 2);
  assert.equal(j.removed, 1);
  assert.equal(j.hunks, 1);
  assert.equal(j.coarse, false);
  assert.equal(
    j.patch,
    [
      "--- team/reg revision 111",
      "+++ team/reg revision 222",
      "@@ -1,3 +1,4 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "+delta",
    ].join("\n"),
  );
});

test("page diff loads both revisions by id", async () => {
  seen = [];
  await run(["page", "diff", "team/reg", "111", "222", "--no-cache"]);
  const from = seen.find((s) => /revision_id=111/.test(s.url));
  const to = seen.find((s) => /revision_id=222/.test(s.url));
  assert.ok(from, "must request the from revision");
  assert.ok(to, "must request the to revision");
  assert.match(from.url, /^\/v1\/pages\?slug=team\/reg&revision_id=111&fields=/);
  assert.match(from.url, /fields=content%2Clast_revision_id/);
});

test("page diff reports identical content", async () => {
  const j = JSON.parse((await run(["page", "diff", "team/reg", "111", "333"])).stdout);
  assert.equal(j.changed, false);
  assert.equal(j.added, 0);
  assert.equal(j.removed, 0);
  assert.equal(j.patch, "");
  const rich = await run(["page", "diff", "team/reg", "111", "333", "--rich-ui=yes"]);
  assert.equal(rich.status, 0, rich.stderr);
  assert.match(rich.stdout, /Ревизии 111 и 333 совпадают\./);
});

test("page diff --context 0 prints minimal hunks in rich mode", async () => {
  const r = await run(["page", "diff", "team/reg", "111", "222", "--context", "0", "--rich-ui=yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /@@ -2 \+2 @@/);
  assert.match(r.stdout, /@@ -3,0 \+4 @@/);
});

test("page diff on a missing revision exits 5", async () => {
  const r = await run(["page", "diff", "team/reg", "111", "999"]);
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /not found/i);
});

test("page diff rejects bad arguments with exit 2", async () => {
  assert.equal((await run(["page", "diff"])).status, 2);
  assert.equal((await run(["page", "diff", "team/reg"])).status, 2);
  assert.equal((await run(["page", "diff", "team/reg", "111"])).status, 2);
  assert.equal((await run(["page", "diff", "team/reg", "111", "abc"])).status, 2);
  assert.equal((await run(["page", "diff", "team/reg", "111", "222", "--context", "51"])).status, 2);
});

test("page diff has its own --help", async () => {
  const r = await run(["page", "diff", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--context/);
});

test("diff output never contains the full token", async () => {
  const r = await run(["page", "diff", "team/reg", "111", "222"]);
  assert.ok(!r.stdout.includes(IAM), "stdout leaked token");
  assert.ok(!r.stderr.includes(IAM), "stderr leaked token");
});
