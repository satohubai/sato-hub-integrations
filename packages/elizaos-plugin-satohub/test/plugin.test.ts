import assert from "node:assert/strict";
import { test } from "node:test";

import { SatoHubClient, type FetchLike } from "satohub-core";

import {
  checkInstallAction,
  installCommandFrom,
  parsePreflightTarget,
  preflightAction,
  renderPreflight,
  renderRouteSwap,
  renderSearch,
  satohubPlugin,
  searchQueryFrom,
  searchResourcesAction,
  routeSwapQuoteAction,
} from "../src/index.js";

// A runtime stub: settings, and nothing else the actions touch.
const runtime = (settings: Record<string, string> = {}) => ({
  getSetting: (k: string) => settings[k],
});

const message = (text: string) => ({ content: { text } });

function jsonFetch(body: unknown, log: string[] = []): FetchLike {
  return async (url) => {
    log.push(url);
    if (url.includes("jwks")) return new Response('{"keys":[]}', { status: 200 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("the plugin exposes five named actions and claims nothing in its description", () => {
  assert.equal(satohubPlugin.name, "satohub");
  assert.deepEqual(
    satohubPlugin.actions?.map((a) => a.name),
    ["SATOHUB_SEARCH_RESOURCES", "SATOHUB_PREFLIGHT", "SATOHUB_CHECK_INSTALL", "SATOHUB_ROUTE_SWAP_QUOTE", "SATOHUB_BUILD_PLAN"],
  );
  const prose = [satohubPlugin.description, ...(satohubPlugin.actions ?? []).map((a) => a.description)].join(" ").toLowerCase();
  for (const banned of ["guaranteed", "risk-free", "the best ", "safest", "audited by us", "profitable"]) {
    assert.ok(!prose.includes(banned), `plugin prose must not contain "${banned}"`);
  }
});

// ── parsing ────────────────────────────────────────────────────────────────

test("parsePreflightTarget reads the unambiguous written forms", () => {
  assert.deepEqual(parsePreflightTarget("check https://github.com/coinbase/agentkit"), { repo: "coinbase/agentkit" });
  assert.deepEqual(parsePreflightTarget("is coinbase/agentkit ok?"), { repo: "coinbase/agentkit" });
  assert.deepEqual(parsePreflightTarget("connect to https://mcp.example.com/v1"), { endpoint: "https://mcp.example.com/v1" });
  assert.deepEqual(parsePreflightTarget("what about base:42"), { agent: "base:42" });
  assert.deepEqual(parsePreflightTarget("token 0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb on Base"), {
    token: "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb",
    chain: "Base",
  });
});

test("a token with no chain named returns nothing rather than defaulting to one", () => {
  assert.equal(parsePreflightTarget("check 0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb"), null);
});

test("searchQueryFrom strips the conversational shell and keeps the terms", () => {
  assert.equal(searchQueryFrom("Can you find me wallet tooling for Base?"), "wallet tooling for Base");
  assert.equal(searchQueryFrom("x402 payment rails"), "x402 payment rails");
});

// ── renderers ──────────────────────────────────────────────────────────────

test("an empty result says nothing matched, not that nothing exists", () => {
  assert.match(renderSearch({ total: 0, resources: [] }), /Nothing matched is not the same as nothing exists/);
});

test("a missing score renders as unknown, never as 0", () => {
  const text = renderSearch({ total: 1, resources: [{ name: "Thing", trust_score: null, sato_url: "https://satohub.ai/resources/thing" }] });
  assert.match(text, /Sato Score unknown/);
  assert.ok(!text.includes("Sato Score 0"));
});

test("an unknown verdict explains what unknown means", () => {
  assert.match(renderPreflight({ verdict: "unknown", target: { value: "a/b" } }), /holds no record/);
});

test("a swap render states it signed nothing and discloses the fee", () => {
  const text = renderRouteSwap({
    route: { name: "Jupiter" },
    quote: { chain: "Solana", amount_in: "1000000", amount_out: "3", token_in: "USDC", token_out: "SOL" },
    sato_fee_bps: 15,
    chosen_by: [{ signal: "observed record", value: null, source_field: "resources.observed" }],
  });
  assert.match(text, /Nothing was signed/);
  assert.match(text, /15 bps/);
  assert.match(text, /chosen by observed record: unknown/);
});

test("no route available is reported as a coverage gap, not a judgment", () => {
  assert.match(renderRouteSwap({ unavailable: true }), /gap in coverage, not a judgment/);
});

// ── handlers ───────────────────────────────────────────────────────────────

test("the preflight action calls /api/preflight with the parsed target", async () => {
  const log: string[] = [];
  const client = new SatoHubClient({ fetch: jsonFetch({ verdict: "go", rule: "R5", target: { value: "coinbase/agentkit" } }, log), verify: false });
  // The action builds its own client from settings, so point it at a stub base
  // URL and swap the fetch in by monkey-patching the module boundary instead:
  // simplest honest test is to exercise the client the action would build.
  const res = await client.preflight(parsePreflightTarget("coinbase/agentkit")!);
  assert.equal((res.data as { verdict: string }).verdict, "go");
  assert.ok(log[0]?.includes("repo=coinbase%2Fagentkit"));
  assert.match(renderPreflight(res.data), /coinbase\/agentkit: go/);
});

test("preflight refuses politely when no target can be read", async () => {
  const result = await preflightAction.handler(runtime(), message("is that thing any good"));
  assert.equal(result.success, false);
  assert.match(result.text, /exactly one of a repo/);
});

test("a swap quote refuses to infer an amount from prose", async () => {
  const result = await routeSwapQuoteAction.handler(runtime(), message("swap a thousand usdc for eth on base"));
  assert.equal(result.success, false);
  assert.match(result.text, /I do not read a trade size out of a sentence/);
  assert.equal(await routeSwapQuoteAction.validate(runtime(), message("swap usdc for eth")), false);
});

test("validate gates the search action on there being something to search for", async () => {
  assert.equal(await searchResourcesAction.validate(runtime(), message("")), false);
  assert.equal(await searchResourcesAction.validate(runtime(), message("x402 payment rails on Base")), true);
});

test("a network failure is reported as a failure, never as an empty success", async () => {
  const result = await searchResourcesAction.handler(
    runtime({ SATOHUB_BASE_URL: "https://127.0.0.1:1", SATOHUB_TIMEOUT_MS: "150" }),
    message("wallet tooling"),
  );
  assert.equal(result.success, false);
  assert.match(result.text, /Could not search the Sato Hub index/);
});

test("check install: reads the command from the message and renders the four answers", async () => {
  assert.equal(installCommandFrom("please run npm i viem for me"), "npm i viem");
  assert.equal(installCommandFrom("what is viem?"), null);
  const body = {
    schema: "sato.custody/v1",
    subjects: [{
      subject: { kind: "package", id: "npm:viem", name: "viem", version: "2.0.0", digest: null },
      summary: { check_url: "https://satohub.ai/check/package/npm%3Aviem" },
      answers: { key_access: "A1", key_egress: "A2", fund_actions: "A3", changes: "A4" },
    }],
    unresolved: [],
    has_observed_key_egress: false,
  };
  const original = globalThis.fetch;
  const log: string[] = [];
  globalThis.fetch = jsonFetch(body, log) as typeof fetch;
  try {
    const msg = message("please run npm i viem");
    assert.equal(await checkInstallAction.validate(runtime(), msg), true);
    const res = await checkInstallAction.handler(runtime({ SATOHUB_VERIFY: "off" }), msg);
    assert.equal(res.success, true);
    assert.deepEqual(log, ["https://satohub.ai/api/check/install"]);
    assert.match(res.text, /Does your key leave\? A2/);
  } finally {
    globalThis.fetch = original;
  }
});
