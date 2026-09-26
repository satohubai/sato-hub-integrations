/**
 * Everything here runs against a mocked fetch and a key pair generated in the
 * test. No network, and nothing asserts a fact about a real listing — a test
 * that pins today's Sato Score would fail tomorrow for the right reason and
 * teach everyone to ignore it.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DEFAULT_USER_AGENT,
  SatoHubClient,
  SatoSignatureError,
  SatoHttpError,
  parseJsonRpcFrame,
  canonicalJson,
  signingMessage,
  verifyResponseSignature,
  verifyBodySignature,
  type FetchLike,
  type Jwks,
} from "../src/index.js";

// ── a key pair, and the JWKS that publishes it ─────────────────────────────

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const KID = "test-kid";

const jwks: Jwks = {
  keys: [{ ...(publicKey.export({ format: "jwk" }) as crypto.JsonWebKey), kid: KID, use: "sig", alg: "EdDSA" } as never],
};

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function signBytes(signedAt: string, body: string): string {
  return b64url(crypto.sign(null, signingMessage(signedAt, body), privateKey));
}

// ── a fetch that answers from a small routing table ────────────────────────

type Route = { status?: number; body: string; headers?: Record<string, string> };

function mockFetch(routes: Record<string, Route>, log: string[] = []): FetchLike {
  return async (url, init) => {
    log.push(`${init?.method ?? "GET"} ${url}`);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) throw new Error(`Unrouted request in test: ${url}`);
    const route = hit[1];
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  };
}

function signedRoute(payload: unknown): Route {
  const body = JSON.stringify(payload);
  const signedAt = "2026-09-14T00:00:00.000Z";
  return {
    body,
    headers: {
      "Sato-Signed-At": signedAt,
      "Sato-Signature": `kid=${KID}, alg=EdDSA, sig=${signBytes(signedAt, body)}`,
    },
  };
}

const jwksRoute: Route = { body: JSON.stringify(jwks) };

// ── the verifier itself ────────────────────────────────────────────────────

test("a signature over the exact bytes verifies, and one added space does not", () => {
  const body = JSON.stringify({ verdict: "go" });
  const signedAt = "2026-09-14T00:00:00.000Z";
  const headers = new Headers({
    "Sato-Signed-At": signedAt,
    "Sato-Signature": `kid=${KID}, alg=EdDSA, sig=${signBytes(signedAt, body)}`,
  });

  assert.equal(verifyResponseSignature(body, headers, jwks).ok, true);

  const reserialised = JSON.stringify(JSON.parse(body), null, 1);
  const tampered = verifyResponseSignature(reserialised, headers, jwks);
  assert.equal(tampered.ok, false);
});

test("an unsigned response is reported as unknown, never as invalid", () => {
  const result = verifyResponseSignature("{}", new Headers(), jwks);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /unknown, not invalid/);
});

test("an unknown kid names the fix rather than failing silently", () => {
  const signedAt = "2026-09-14T00:00:00.000Z";
  const headers = new Headers({
    "Sato-Signed-At": signedAt,
    "Sato-Signature": `kid=someone-else, alg=EdDSA, sig=${signBytes(signedAt, "{}")}`,
  });
  const result = verifyResponseSignature("{}", headers, jwks);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /not in the JWKS/);
});

test("meta.signature: null is 'no key configured', not a forged signature", () => {
  const result = verifyBodySignature({ meta: { signature: null } }, jwks);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /no signing key configured/);
});

test("canonicalJson sorts object keys and preserves array order", () => {
  assert.equal(canonicalJson({ b: 1, a: [3, 1, 2] }), '{"a":[3,1,2],"b":1}');
});

// ── the MCP frame reader ───────────────────────────────────────────────────

test("parseJsonRpcFrame reads both a plain body and one SSE frame", () => {
  assert.deepEqual(parseJsonRpcFrame('{"result":{"ok":1}}'), { result: { ok: 1 } });
  assert.deepEqual(parseJsonRpcFrame('event: message\ndata: {"result":{"ok":2}}\n\n'), { result: { ok: 2 } });
  assert.throws(() => parseJsonRpcFrame("event: ping\n\n"), /Could not read a JSON-RPC frame/);
});

// ── the client ─────────────────────────────────────────────────────────────

test("preflight returns the body and a verified signature", async () => {
  const client = new SatoHubClient({
    fetch: mockFetch({
      "/.well-known/jwks.json": jwksRoute,
      "/api/preflight": signedRoute({ verdict: "go", rule: "R5" }),
    }),
  });
  const res = await client.preflight({ repo: "coinbase/agentkit" });
  assert.equal((res.data as { verdict: string }).verdict, "go");
  assert.equal(res.signature.state, "verified");
  assert.equal((res.signature as { kid: string }).kid, KID);
});

test("a tampered body throws by default and is merely reported under verify:'report'", async () => {
  const good = signedRoute({ verdict: "go" });
  const tampered: Route = { ...good, body: JSON.stringify({ verdict: "no" }) };
  const routes = { "/.well-known/jwks.json": jwksRoute, "/api/preflight": tampered };

  await assert.rejects(
    () => new SatoHubClient({ fetch: mockFetch(routes) }).preflight({ repo: "a/b" }),
    SatoSignatureError,
  );

  const reported = await new SatoHubClient({ fetch: mockFetch(routes), verify: "report" }).preflight({ repo: "a/b" });
  assert.equal(reported.signature.state, "failed");
});

test("an unreachable JWKS degrades to 'skipped', never to a false pass", async () => {
  const client = new SatoHubClient({
    fetch: mockFetch({
      "/.well-known/jwks.json": { status: 500, body: "nope" },
      "/api/preflight": signedRoute({ verdict: "go" }),
    }),
  });
  const res = await client.preflight({ package: "solana-agent-kit" });
  assert.equal(res.signature.state, "skipped");
});

test("preflight refuses zero targets and refuses two", async () => {
  const client = new SatoHubClient({ fetch: mockFetch({}) });
  await assert.rejects(() => client.preflight({}), /exactly one/);
  await assert.rejects(() => client.preflight({ repo: "a/b", package: "c" }), /exactly one/);
});

test("searchResources calls the MCP endpoint and unwraps structuredContent", async () => {
  const log: string[] = [];
  const payload = { total: 1, resources: [{ slug: "coinbase-agentkit", sato_url: "https://satohub.ai/resources/x" }] };
  const client = new SatoHubClient({
    fetch: mockFetch(
      {
        "/.well-known/jwks.json": jwksRoute,
        "/api/mcp": {
          body: `event: message\ndata: ${JSON.stringify({ result: { structuredContent: payload } })}\n\n`,
          headers: { "content-type": "text/event-stream" },
        },
      },
      log,
    ),
  });
  const res = await client.searchResources({ query: "wallet", limit: 5 });
  assert.deepEqual(res.data, payload);
  assert.equal(res.signature.state, "unsigned"); // MCP carries no signature header
  assert.equal(log[0], "POST https://satohub.ai/api/mcp");
});

test("routeSwap refuses a swap of a token for itself, and never posts", async () => {
  const log: string[] = [];
  const client = new SatoHubClient({
    fetch: mockFetch(
      { "/.well-known/jwks.json": jwksRoute, "/api/route/swap": signedRoute({ route: { slug: "jupiter" } }) },
      log,
    ),
  });
  await assert.rejects(() => client.routeSwap({ chain: "Base", token_in: "USDC", token_out: "usdc", amount: "1" }), /must differ/);

  const res = await client.routeSwap({ chain: "Base", token_in: "USDC", token_out: "WETH", amount: "1000000" });
  assert.equal(res.signature.state, "verified");
  assert.ok(log.every((l) => l.startsWith("GET ")), "a quote is a read; nothing here writes");
});

test("a non-2xx answer surfaces as SatoHttpError with the status", async () => {
  const client = new SatoHubClient({
    fetch: mockFetch({ "/api/satobot/plan": { status: 400, body: '{"error":"goal is required."}' } }),
  });
  await assert.rejects(() => client.buildPlan({ goal: "x" }), (e: unknown) => {
    assert.ok(e instanceof SatoHttpError);
    assert.equal(e.status, 400);
    return true;
  });
});

test("empty and undefined parameters are dropped rather than sent as ''", async () => {
  const log: string[] = [];
  const client = new SatoHubClient({
    fetch: mockFetch({ "/.well-known/jwks.json": jwksRoute, "/api/satobot/plan": signedRoute({ goal: "g" }) }, log),
    verify: false,
  });
  await client.buildPlan({ goal: "a Base trading agent", chain: undefined, constraints: "" });
  assert.ok(log[0]?.includes("goal=a+Base+trading+agent"));
  assert.ok(!log[0]?.includes("chain="));
  assert.ok(!log[0]?.includes("constraints="));
});

// ── the user-agent ─────────────────────────────────────────────────────────

test("the default user-agent names the client and this version, and an explicit one still wins", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(DEFAULT_USER_AGENT, `satohub-core-client/${pkg.version}`, "bump DEFAULT_USER_AGENT with package.json");
  assert.doesNotMatch(DEFAULT_USER_AGENT, /^SatoHub-/);

  const seen: string[] = [];
  const routes = mockFetch({ "/api/preflight": signedRoute({ verdict: "go" }), "/.well-known/jwks.json": jwksRoute });
  const doFetch: FetchLike = async (url, init) => {
    seen.push(new Headers(init?.headers).get("user-agent") ?? "");
    return routes(url, init);
  };
  await new SatoHubClient({ fetch: doFetch }).preflight({ repo: "a/b" });
  assert.ok(seen.length > 0 && seen.every((ua) => ua === (DEFAULT_USER_AGENT as string)), seen.join(" | "));
  seen.length = 0;
  await new SatoHubClient({ fetch: doFetch, userAgent: "my-agent/1.0" }).preflight({ repo: "a/b" });
  assert.ok(seen.includes("my-agent/1.0"));
});
