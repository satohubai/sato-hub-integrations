/**
 * One opt-in test against the real https://satohub.ai. Skipped unless
 * SATOHUB_LIVE=1 (`npm run test:live -w agentkit-satohub`), so CI never
 * depends on the network.
 *
 * It asserts the SHAPE of a live answer, never a fact about a listing: a test
 * that pinned today's verdict or score would fail tomorrow for the right
 * reason, and teach everyone to ignore it.
 *
 * AgentKit's own analytics beacon (to Coinbase, on every action call) is
 * answered locally so this test reaches satohub.ai and nothing else.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { satohubActionProvider } from "../src/index.js";

const LIVE = process.env.SATOHUB_LIVE === "1";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (new URL(url).hostname.endsWith("coinbase.com")) return new Response(null, { status: 200 });
  return realFetch(input, init);
}) as typeof fetch;

test("live: preflight answers with a verdict, its meaning and a signature state", { skip: !LIVE && "set SATOHUB_LIVE=1" }, async () => {
  const p = satohubActionProvider({ userAgent: "agentkit-satohub-live-test/0.1.0" });
  const out = JSON.parse(await p.preflight({ targetType: "repo", target: "coinbase/agentkit", chain: null })) as {
    success: boolean;
    verdict: string;
    meaning: string;
    evidence: unknown[];
    signature: { state: string };
  };
  assert.equal(out.success, true, JSON.stringify(out));
  assert.ok(["go", "caution", "no", "unknown"].includes(out.verdict));
  assert.ok(out.meaning.length > 0);
  assert.ok(Array.isArray(out.evidence));
  assert.ok(["verified", "unsigned"].includes(out.signature.state), `signature: ${out.signature.state}`);
});

test("live: search_resources answers with a list", { skip: !LIVE && "set SATOHUB_LIVE=1" }, async () => {
  const p = satohubActionProvider({ userAgent: "agentkit-satohub-live-test/0.1.0" });
  const out = JSON.parse(await p.searchResources({ query: "wallet", chain: null, limit: 2 })) as {
    success: boolean;
    resources: unknown[];
  };
  assert.equal(out.success, true, JSON.stringify(out));
  assert.ok(Array.isArray(out.resources));
});
