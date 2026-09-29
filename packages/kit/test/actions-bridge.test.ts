import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, erc20Abi } from "viem";
import { ActionInputError, NO_SATO_FEE_STATEMENT, bridgeQuote, buildBridgePrepare } from "../src/actions/index.js";
import { TEST_UA, ctxWith, fakeClient, fakeFetch, fixture } from "./fixtures/actions-harness.js";

const SATO = fixture("sato-bridge-recommend.base-arbitrum.json");
const SATO_TX = fixture("sato-bridge-build-tx.base-arbitrum.json");
const SATO_WITHHELD = fixture("sato-bridge-build-tx-withheld.base-arbitrum.json");
const LIFI = fixture("lifi-quote.bridge.base-arbitrum.json");
const SAME_CHAIN_SATO = fixture("sato-swap-recommend.base.json");
const isSato = (u: string) => u.startsWith("https://satohub.ai/");
const isLifi = (u: string) => u.startsWith("https://li.quest/");

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const FROM = "0x1111111111111111111111111111111111111111";
const INPUT = { from_chain: "base", to_chain: "arbitrum", from_token: USDC_BASE, to_token: USDC_ARB, from_amount: "10000000", slippage_bps: 50 };

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
  return out;
}

test("bridge.quote default: Sato cross-chain quote + LI.FI no-Sato-fee quote, unranked, fee quoted from the response", async () => {
  const f = fakeFetch([{ match: isSato, body: SATO }, { match: isLifi, body: LIFI }]);
  const out = await bridgeQuote(INPUT, ctxWith({ fetch: f.fetch }));
  assert.equal(out.order, "as_requested");
  assert.equal(out.lane, "cross-chain");
  assert.deepEqual(out.quotes.map((q) => q.venue), ["sato", "lifi"]);
  for (const k of keysDeep(out)) assert.doesNotMatch(k, /rank|best|recommend|winner|score|preferred/i, k);
  const [s, l] = out.quotes;
  assert.equal(s!.fee_disclosure, SATO.disclosure);
  assert.equal(s!.sato_fee_bps, SATO.sato_fee_bps); // the response's figure, never a typed constant
  assert.equal(s!.sato_fee_recipient, SATO.sato_fee_recipient);
  assert.equal(s!.to_amount, SATO.amount_out);
  assert.equal(s!.route_via, SATO.venue);
  assert.equal(l!.sato_fee_bps, 0);
  assert.equal(l!.fee_disclosure, NO_SATO_FEE_STATEMENT);
  assert.deepEqual((l!.upstream_fees as { feeCosts: unknown }).feeCosts, LIFI.estimate.feeCosts);
  assert.equal(l!.to_amount, LIFI.estimate.toAmount);
  assert.equal(l!.est_duration_s, LIFI.estimate.executionDuration);
  assert.ok(out.quotes.every((q) => q.tx === null && q.error === null && q.lane === "cross-chain"));
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) assert.equal(c.headers["user-agent"], TEST_UA);
  const satoCall = f.calls.find((c) => isSato(c.url))!;
  assert.deepEqual(satoCall.body, { chain_in: "base", chain_out: "arbitrum", token_in: USDC_BASE, token_out: USDC_ARB, amount_in: "10000000", slippage_bps: 50, mode: "recommend" });
  const u = new URL(f.calls.find((c) => isLifi(c.url))!.url);
  assert.equal(u.searchParams.get("fromChain"), "8453");
  assert.equal(u.searchParams.get("toChain"), "42161");
});

for (const venue of ["direct", "lifi"]) {
  test(`bridge.quote venue ${venue}: zero requests to satohub.ai`, async () => {
    const f = fakeFetch([{ match: isSato, body: SATO }, { match: isLifi, body: LIFI }]);
    const out = await bridgeQuote({ ...INPUT, venue }, ctxWith({ fetch: f.fetch }));
    assert.equal(f.calls.filter((c) => isSato(c.url)).length, 0);
    assert.deepEqual(out.quotes.map((q) => q.venue), ["lifi"]);
    assert.equal(out.quotes[0]!.sato_fee_bps, 0);
  });
}

test("bridge.quote refuses a same-chain request (that is swap.quote) before any request", async () => {
  const f = fakeFetch([]);
  await assert.rejects(bridgeQuote({ ...INPUT, to_chain: "base" }, ctxWith({ fetch: f.fetch })), ActionInputError);
  await assert.rejects(bridgeQuote({ ...INPUT, venue: "0x" }, ctxWith({ fetch: f.fetch })), ActionInputError);
  assert.equal(f.calls.length, 0);
});

test("bridge.quote never lists a same-chain Sato answer beside a cross-chain quote", async () => {
  const f = fakeFetch([{ match: isSato, body: SAME_CHAIN_SATO }, { match: isLifi, body: LIFI }]);
  const out = await bridgeQuote(INPUT, ctxWith({ fetch: f.fetch }));
  assert.match(out.quotes[0]!.error!, /^lane_mismatch/);
  assert.equal(out.quotes[0]!.to_amount, null);
  assert.equal(out.quotes[0]!.sato_fee_bps, null);
});

test("bridge.quote keeps a failed Sato answer visible instead of dropping it", async () => {
  const f = fakeFetch([{ match: isSato, status: 503, body: { error: "down" } }, { match: isLifi, body: LIFI }]);
  const out = await bridgeQuote(INPUT, ctxWith({ fetch: f.fetch }));
  assert.match(out.quotes[0]!.error!, /^http_503/);
  assert.equal(out.quotes[1]!.error, null);
});

function allowanceClient(allowance: bigint) {
  return fakeClient({ readContract: async (a: { functionName: string }) => { assert.equal(a.functionName, "allowance"); return allowance; } });
}

test("bridge.prepare sato: source-chain tx, Sato disclosure verbatim, direct quote available", async () => {
  const f = fakeFetch([{ match: isSato, body: SATO_TX }, { match: isLifi, body: LIFI }]);
  const { client } = allowanceClient(10n ** 30n);
  const b = await buildBridgePrepare({ ...INPUT, from_address: FROM }, ctxWith({ fetch: f.fetch, client }));
  const u = b.unsigned as { kind: string; chain: string; chain_id: number; to: string; data: string };
  assert.equal(u.kind, "evm_tx");
  assert.equal(u.chain, "base");
  assert.equal(u.chain_id, 8453);
  assert.equal(u.to, SATO_TX.tx.to);
  assert.equal(u.data, SATO_TX.tx.data);
  assert.deepEqual(b.fee_disclosure, { venue: "sato", fee_bps: SATO_TX.sato_fee_bps, fee_recipient: SATO_TX.sato_fee_recipient, statement: SATO_TX.disclosure, direct_quote_available: true });
  assert.equal((b.params as { step: string }).step, "bridge");
  assert.equal(b.facts.usd_value, 10);
  assert.equal(b.facts.chain, "base");
  const body = f.calls.find((c) => isSato(c.url))!.body as Record<string, unknown>;
  assert.equal(body.mode, "build-tx");
  assert.equal(body.taker, FROM);
  assert.equal(body.chain_out, "arbitrum");
  assert.doesNotMatch(b.summary, /\bbest\b|recommended|safe/i);
});

test("bridge.prepare: short allowance prepares the exact-amount approve first", async () => {
  const f = fakeFetch([{ match: isSato, body: SATO_TX }, { match: isLifi, body: LIFI }]);
  const { client } = allowanceClient(0n);
  const b = await buildBridgePrepare({ ...INPUT, from_address: FROM }, ctxWith({ fetch: f.fetch, client }));
  const u = b.unsigned as { to: string; data: `0x${string}`; value: string };
  assert.equal(u.to, USDC_BASE);
  assert.equal(u.value, "0");
  const dec = decodeFunctionData({ abi: erc20Abi, data: u.data });
  assert.equal(dec.functionName, "approve");
  assert.deepEqual(dec.args, [SATO_TX.tx.approval_target, 10000000n]);
  assert.equal((b.params as { step: string }).step, "approve");
  assert.match(b.summary, /^Approve /);
});

for (const venue of ["direct", "lifi"]) {
  test(`bridge.prepare venue ${venue}: LI.FI source tx, no Sato call, no Sato fee`, async () => {
    const f = fakeFetch([{ match: isSato, body: SATO_TX }, { match: isLifi, body: LIFI }]);
    const { client } = allowanceClient(10n ** 30n);
    const b = await buildBridgePrepare({ ...INPUT, from_address: FROM, venue }, ctxWith({ fetch: f.fetch, client }));
    assert.equal(f.calls.filter((c) => isSato(c.url)).length, 0);
    assert.equal((b.unsigned as { to: string }).to, LIFI.transactionRequest.to);
    assert.equal(b.fee_disclosure!.venue, "lifi");
    assert.equal(b.fee_disclosure!.fee_bps, null);
    assert.ok(b.fee_disclosure!.statement.startsWith(NO_SATO_FEE_STATEMENT));
    assert.equal(b.facts.usd_value, Number(LIFI.estimate.fromAmountUSD));
  });
}

test("bridge.prepare needs from_address and refuses a withheld Sato tx (recorded)", async () => {
  await assert.rejects(buildBridgePrepare(INPUT, ctxWith()), ActionInputError);
  const f = fakeFetch([{ match: isSato, body: SATO_WITHHELD }, { match: isLifi, body: LIFI }]);
  await assert.rejects(buildBridgePrepare({ ...INPUT, from_address: FROM }, ctxWith({ fetch: f.fetch })), /no executable transaction — withheld: E1/);
});
