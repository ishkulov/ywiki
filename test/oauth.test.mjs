// ywiki/tests/oauth.test.mjs
// OAuth 2.0 + PKCE helpers. No network: the token endpoint is a fetch stub and
// the callback server listens on an ephemeral loopback port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  AUTHORIZE_ENDPOINT,
  TOKEN_ENDPOINT,
  buildAuthorizeUrl,
  buildTokenPageUrl,
  exchangeCode,
  openBrowser,
  pkce,
  refreshAccessToken,
  startCallbackServer,
} from "../lib/oauth.mjs";
import { AuthError } from "../lib/credentials.mjs";

test("pkce returns a verifier and its S256 challenge", () => {
  const { verifier, challenge } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,}$/);
  assert.equal(challenge, createHash("sha256").update(verifier, "ascii").digest("base64url"));
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});

test("buildAuthorizeUrl carries the code flow parameters", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "cid",
      redirectUri: "http://127.0.0.1:21332/callback",
      state: "state-1",
      challenge: "challenge-1",
      scope: "wiki:read",
    }),
  );
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_ENDPOINT);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:21332/callback");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "wiki:read");
});

test("buildTokenPageUrl points at the token page", () => {
  const url = new URL(buildTokenPageUrl({ clientId: "cid" }));
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), null);

  const withRedirect = new URL(
    buildTokenPageUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:21332/callback" }),
  );
  assert.equal(withRedirect.searchParams.get("redirect_uri"), "http://127.0.0.1:21332/callback");
});

test("callback server accepts a matching state and returns the code", async () => {
  const server = await startCallbackServer({ ports: [0], state: "state-1", timeoutMs: 2000 });
  const done = server.done.then(
    (code) => ({ ok: true, code }),
    (error) => ({ ok: false, error }),
  );
  try {
    const res = await fetch(`${server.redirectUri}?code=abc&state=state-1`);
    assert.equal(res.status, 200);
    const result = await done;
    assert.equal(result.ok, true);
    assert.equal(result.code, "abc");
  } finally {
    await server.close();
  }
});

test("callback server rejects a state mismatch", async () => {
  const server = await startCallbackServer({ ports: [0], state: "good", timeoutMs: 2000 });
  const done = server.done.then(
    (code) => ({ ok: true, code }),
    (error) => ({ ok: false, error }),
  );
  try {
    const res = await fetch(`${server.redirectUri}?code=abc&state=bad`);
    assert.equal(res.status, 400);
    const result = await done;
    assert.equal(result.ok, false);
    assert.match(result.error.message, /state mismatch/);
  } finally {
    await server.close();
  }
});

test("callback server times out when no callback arrives", async () => {
  const server = await startCallbackServer({ ports: [0], state: "s", timeoutMs: 100 });
  const done = server.done.then(
    (code) => ({ ok: true, code }),
    (error) => ({ ok: false, error }),
  );
  try {
    const result = await done;
    assert.equal(result.ok, false);
    assert.match(result.error.message, /не получен/);
  } finally {
    await server.close();
  }
});

test("exchangeCode posts the authorization_code grant", async () => {
  /** @type {{ url: string, body: string } | null} */
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), body: String(init.body) };
    return new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "bearer" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const data = await exchangeCode({
    tokenEndpoint: "https://example.test/token",
    clientId: "cid",
    code: "code-1",
    verifier: "verifier-1",
    fetchImpl,
  });

  assert.equal(data.access_token, "at");
  assert.equal(data.refresh_token, "rt");
  assert.ok(captured);
  assert.equal(captured.url, "https://example.test/token");
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("client_id"), "cid");
  assert.equal(params.get("code"), "code-1");
  assert.equal(params.get("code_verifier"), "verifier-1");
  assert.equal(params.get("redirect_uri"), null, "redirect_uri is not sent");
});

test("refreshAccessToken posts the refresh_token grant", async () => {
  /** @type {{ url: string, body: string } | null} */
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), body: String(init.body) };
    return new Response(JSON.stringify({ access_token: "new-at", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const data = await refreshAccessToken({
    tokenEndpoint: "https://example.test/token",
    clientId: "cid",
    refreshToken: "rt",
    fetchImpl,
  });

  assert.equal(data.access_token, "new-at");
  assert.ok(captured);
  assert.equal(captured.url, "https://example.test/token");
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("client_id"), "cid");
  assert.equal(params.get("refresh_token"), "rt");
});

test("token endpoint errors become AuthError", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad grant" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    () =>
      exchangeCode({
        tokenEndpoint: "https://example.test/token",
        clientId: "cid",
        code: "code",
        verifier: "verifier",
        redirectUri: "http://127.0.0.1:43110/callback",
        fetchImpl,
      }),
    (e) => e instanceof AuthError && e.kind === "unauthenticated" && /bad grant/.test(e.message),
  );
});

test("network failure at the token endpoint becomes unavailable", async () => {
  const fetchImpl = async () => {
    throw new Error("boom");
  };
  await assert.rejects(
    () =>
      refreshAccessToken({
        tokenEndpoint: "https://example.test/token",
        clientId: "cid",
        refreshToken: "rt",
        fetchImpl,
      }),
    (e) => e instanceof AuthError && e.kind === "unavailable" && /boom/.test(e.message),
  );
});

test("openBrowser reports whether an opener was available", async () => {
  /** @type {Array<{ cmd: string, args: string[] }>} */
  const calls = [];
  const ok = await openBrowser("https://example.test/auth", {
    run: (cmd, args, opts, cb) => {
      calls.push({ cmd, args });
      cb(null);
    },
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "https://example.test/auth");

  const failed = await openBrowser("https://example.test/auth", {
    run: (cmd, args, opts, cb) => cb(new Error("no opener")),
  });
  assert.equal(failed, false);
});
