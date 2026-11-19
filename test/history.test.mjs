// ywiki/test/history.test.mjs
// Tests for the read-only history commands: pure helpers (`lib/history.mjs`)
// plus end-to-end CLI behaviour against a local stub HTTP server.
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

import {
  validateRevisionPageSize,
  revisionQuery,
  parseRevisionIds,
  revisionSummary,
  revisionHead,
  revisionOf,
  isCurrentRevision,
} from "../lib/history.mjs";
import { UsageError } from "../lib/output.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "ywiki.mjs");

const IAM_PREFIX = ["t", "1", "."].join("");
const IAM = IAM_PREFIX + "B".repeat(40);

const CURRENT = 74307249;
const OLDER = 74280721;
const OLDEST = 74100001;

/** @type {import("node:http").Server} */
let server;
let baseUrl;
let cacheDir;
/** @type {Array<{method:string,url:string}>} */
let seen = [];

function revision(id, username, createdAt, extra = {}) {
  return {
    id,
    author: { username, display_name: username.toUpperCase() },
    created_at: createdAt,
    page_type: "wysiwyg",
    revision_draft: null,
    publication: null,
    ...extra,
  };
}

const REV_CURRENT = revision(CURRENT, "alice", "2026-07-28T07:36:30.973Z", {
  publication: { status: "published" },
});
const REV_OLDER = revision(OLDER, "bob", "2026-07-27T10:27:02.206Z");
const REV_OLDEST = revision(OLDEST, "carol", "2026-07-26T08:00:00Z");

before(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "ywiki-history-cache-"));
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
        const rev = url.searchParams.get("revision_id");
        if (rev === "999") return send(404, { error_code: "NOT_FOUND" });
        if (rev) {
          const id = Number(rev);
          const meta = id === CURRENT ? REV_CURRENT : REV_OLDER;
          return send(200, {
            id: 42,
            slug,
            title: "Заголовок",
            page_type: "wysiwyg",
            last_revision_id: CURRENT,
            attributes: { modified_at: "2026-07-28T07:36:31.015Z" },
            active_revision: meta,
            content: "Y".repeat(20000),
          });
        }
        if (slug === "empty-history") {
          return send(200, { id: 43, slug, title: "Пустая", page_type: "wysiwyg", last_revision_id: null });
        }
        return send(200, { id: 42, slug, title: "Заголовок", page_type: "wysiwyg", last_revision_id: CURRENT });
      }
      if (req.method === "GET" && url.pathname === "/v1/pages/42/revisions") {
        if (url.searchParams.get("ids")) {
          return send(200, { results: [REV_OLDEST], next_cursor: null, prev_cursor: null });
        }
        if (url.searchParams.get("cursor") === "c2") {
          return send(200, { results: [REV_OLDEST], next_cursor: null, prev_cursor: "c1" });
        }
        return send(200, { results: [REV_CURRENT, REV_OLDER], next_cursor: "c2", prev_cursor: null });
      }
      if (req.method === "GET" && url.pathname === "/v1/pages/43/revisions") {
        return send(200, { results: [], next_cursor: null, prev_cursor: null });
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("revisionQuery builds page_size, string cursor and ids", () => {
  assert.equal(revisionQuery(), "");
  assert.equal(revisionQuery({ pageSize: 10 }), "?page_size=10");
  assert.equal(revisionQuery({ pageSize: 50 }), "?page_size=50");
  assert.equal(
    revisionQuery({ pageSize: 25, cursor: "eyJ2IjpbXSwicCI6MX0=", ids: "1,2" }),
    "?page_size=25&cursor=eyJ2IjpbXSwicCI6MX0%3D&ids=1%2C2",
  );
  assert.equal(revisionQuery({ cursor: "", ids: "" }), "");
});

test("revision page size is limited to 1–50", () => {
  for (const bad of [0, 51, 1.5, Number.NaN]) {
    assert.throws(() => validateRevisionPageSize(bad), UsageError);
    assert.throws(() => revisionQuery({ pageSize: bad }), UsageError);
  }
  assert.equal(validateRevisionPageSize(25), 25);
});

test("parseRevisionIds accepts a comma-separated id list only", () => {
  assert.equal(parseRevisionIds(" 1,2,3 "), "1,2,3");
  for (const bad of ["", "1,", "1,,2", "1,x", "-1"]) {
    assert.throws(() => parseRevisionIds(bad), UsageError);
  }
});

test("revisionSummary normalises a revision", () => {
  const raw = {
    id: CURRENT,
    author: { username: "alice", display_name: "Алиса" },
    created_at: "2026-07-28T07:36:30.973Z",
    page_type: "wysiwyg",
    revision_draft: { id: 5, created_at: "2026-07-28T08:00:00Z", modified_at: "2026-07-28T09:00:00Z" },
    publication: { status: "pending_publication" },
  };
  assert.deepEqual(revisionSummary(raw), {
    id: CURRENT,
    created_at: "2026-07-28T07:36:30.973Z",
    author: "alice",
    display_name: "Алиса",
    page_type: "wysiwyg",
    publication: "pending_publication",
    draft: { id: 5, created_at: "2026-07-28T08:00:00Z", modified_at: "2026-07-28T09:00:00Z" },
  });
  assert.deepEqual(revisionSummary({}), {
    id: null,
    created_at: null,
    author: null,
    display_name: null,
    page_type: null,
    publication: null,
    draft: null,
  });
});

test("revisionHead marks publication, draft and the current revision", () => {
  const raw = {
    id: 7,
    author: { username: "alice" },
    created_at: "2026-07-28T07:36:30.973Z",
    revision_draft: { id: 5 },
    publication: { status: "pending_publication" },
  };
  assert.equal(
    revisionHead(raw),
    "#7 2026-07-28T07:36:30.973Z alice [pending_publication] [draft]",
  );
  assert.equal(revisionHead(raw, { current: true }), "#7 2026-07-28T07:36:30.973Z alice [pending_publication] [draft] ← current");
  assert.equal(revisionHead({ id: 7 }), "#7");
});

test("revisionOf and isCurrentRevision read page metadata", () => {
  assert.equal(revisionOf({}), null);
  assert.equal(revisionOf({ active_revision: REV_CURRENT }).id, CURRENT);
  assert.equal(isCurrentRevision({ id: CURRENT }, CURRENT), true);
  assert.equal(isCurrentRevision({ id: CURRENT }, String(CURRENT)), true);
  assert.equal(isCurrentRevision({ id: OLDER }, CURRENT), false);
  assert.equal(isCurrentRevision(null, CURRENT), false);
  assert.equal(isCurrentRevision({ id: CURRENT }, null), false);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("page history resolves the id and lists revisions as JSON", async () => {
  const r = await run(["page", "history", "team/reg"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.slug, "team/reg");
  assert.equal(j.id, 42);
  assert.equal(j.last_revision_id, CURRENT);
  assert.equal(j.results.length, 2);
  assert.deepEqual(j.results[0], {
    id: CURRENT,
    created_at: "2026-07-28T07:36:30.973Z",
    author: "alice",
    display_name: "ALICE",
    page_type: "wysiwyg",
    publication: "published",
    draft: null,
  });
  assert.equal(j.next_cursor, "c2");
});

test("page history sends page_size and ids to the revisions endpoint", async () => {
  seen = [];
  await run(["page", "history", "team/reg", "--limit", "2", "--ids", "5,6", "--no-cache"]);
  const revs = seen.find((s) => /\/pages\/42\/revisions/.test(s.url));
  assert.ok(revs, "must call the revisions endpoint");
  assert.match(revs.url, /^\/v1\/pages\/42\/revisions\?/);
  assert.match(revs.url, /page_size=2/);
  assert.match(revs.url, /ids=5%2C6/);
  const resolve = seen.find((s) => s.url.startsWith("/v1/pages?") && !/revision_id=/.test(s.url));
  assert.ok(resolve, "must resolve the slug first");
  assert.match(resolve.url, /fields=last_revision_id/);
});

test("page history --all follows the string cursor", async () => {
  seen = [];
  const r = await run(["page", "history", "team/reg", "--all"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.results.length, 3);
  assert.equal(j.results[2].id, OLDEST);
  assert.equal(j.next_cursor, null);
  assert.ok(seen.some((s) => /cursor=c2/.test(s.url)), "must request the next cursor");
});

test("page history rich output marks the current revision", async () => {
  const r = await run(["page", "history", "team/reg", "--rich-ui=yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /#74307249 .*alice \[published\] ← current/);
  assert.match(r.stdout, /#74280721 .*bob/);
});

test("page history on a page without revisions gives an empty hint", async () => {
  const rich = await run(["page", "history", "empty-history", "--rich-ui=yes"]);
  assert.equal(rich.status, 0, rich.stderr);
  assert.match(rich.stdout, /История пуста/);
  const j = JSON.parse((await run(["page", "history", "empty-history"])).stdout);
  assert.deepEqual(j.results, []);
  assert.equal(j.last_revision_id, null);
});

test("page revision reads one revision and clips the content", async () => {
  seen = [];
  const r = await run(["page", "revision", "team/reg", String(OLDER), "--limit", "100"]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.slug, "team/reg");
  assert.equal(j.id, 42);
  assert.equal(j.revision_id, OLDER);
  assert.equal(j.current, false);
  assert.equal(j.revision.id, OLDER);
  assert.equal(j.revision.author, "bob");
  assert.equal(j.content.length, 100);
  assert.equal(j.truncated, true);
  assert.equal(j.next_offset, 100);
  const req = seen.find((s) => /revision_id=74280721/.test(s.url));
  assert.ok(req, "must ask for the revision by id");
  assert.match(req.url, /^\/v1\/pages\?slug=team\/reg&revision_id=74280721&fields=/);
  assert.match(req.url, /fields=content%2Cattributes%2Clast_revision_id/);
});

test("page revision marks the current revision and hints the next offset", async () => {
  const r = await run(["page", "revision", "team/reg", String(CURRENT), "--limit", "10", "--rich-ui=yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /revision: 74307249 — alice \(2026-07-28T07:36:30\.973Z\) — current/);
  assert.match(r.stdout, /--offset 10/);
});

test("page revision on a missing revision exits 5", async () => {
  const r = await run(["page", "revision", "team/reg", "999"]);
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /not found/i);
});

test("page history and page revision reject bad arguments with exit 2", async () => {
  assert.equal((await run(["page", "history"])).status, 2);
  assert.equal((await run(["page", "history", "team/reg", "--limit", "51"])).status, 2);
  assert.equal((await run(["page", "history", "team/reg", "--ids", "1,x"])).status, 2);
  assert.equal((await run(["page", "revision", "team/reg"])).status, 2);
  assert.equal((await run(["page", "revision", "team/reg", "abc"])).status, 2);
});

test("page history and page revision have their own --help", async () => {
  const history = await run(["page", "history", "--help"]);
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /--ids/);
  const revisionHelp = await run(["page", "revision", "--help"]);
  assert.equal(revisionHelp.status, 0, revisionHelp.stderr);
  assert.match(revisionHelp.stdout, /revision-id/);
});

test("history output never contains the full token", async () => {
  for (const args of [
    ["page", "history", "team/reg"],
    ["page", "revision", "team/reg", String(OLDER)],
  ]) {
    const r = await run(args);
    assert.ok(!r.stdout.includes(IAM), `stdout leaked token for ${args.join(" ")}`);
    assert.ok(!r.stderr.includes(IAM), `stderr leaked token for ${args.join(" ")}`);
  }
});
