import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, erc20Abi } from "viem";
import { ActionInputError, NO_SATO_FEE_STATEMENT, buildSwapPrepare, swapQuote } from "../src/actions/index.js";
import { TEST_UA, ctxWith, fakeClient, fakeFetch, fixture } from "./fixtures/actions-harness.js";

const SATO = fixture("sato-swap-recommend.base.json");
const SATO_TX = fixture("sato-swap-build-tx.base.json");
const LIFI = fixture("lifi-quote.base.json");
const isSato = (u: string) => u.startsWith("https://satohub.ai/");
const isLifi = (u: string) => u.startsWith("https://li.quest/");
const isZeroex = (u: string) => u.startsWith("https://api.0x.org/");

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const TAKER = "0x1111111111111111111111111111111111111111";
const INPUT = { chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "10000000", slippage_bps: 50 };

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
  return out;
}

test("swap.quote default: Sato quote + no-Sato-fee quote, unranked, disclosure verbatim", async () => {
  const f = fakeFetch([{ match: isSato, body: SATO }, { match: isLifi, body: LIFI }]);
  const out = await swapQuote(INPUT, ctxWith({ fetch: f.fetch }));
  assert.equal(out.order, "as_requested");
  assert.deepEqual(out.quotes.map((q) => q.venue), ["sato", "lifi"]);
  for (const k of keysDeep(out)) assert.doesNotMatch(k, /rank|best|recommend|winner|score|preferred/i, k);
  const [s, l] = out.quotes;
  assert.equal(s!.fee_disclosure, SATO.disclosure);
  assert.equal(s!.sato_fee_bps, SATO.sato_fee_bps);
  assert.equal(s!.sato_fee_recipient, SATO.sato_fee_recipient);
  assert.equal(s!.buy_amount, SATO.amount_out);
  assert.equal(s!.route_via, SATO.venue);
  assert.equal(l!.sato_fee_bps, 0);
  assert.equal(l!.fee_disclosure, NO_SATO_FEE_STATEMENT);
  assert.deepEqual((l!.upstream_fees as { feeCosts: unknown }).feeCosts, LIFI.estimate.feeCosts);
  assert.equal(l!.buy_amount, LIFI.estimate.toAmount);
  assert.ok(out.quotes.every((q) => q.tx === null && q.error === null));
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) assert.equal(c.headers["user-agent"], TEST_UA);
  const satoCall = f.calls.find((c) => isSato(c.url))!;
  assert.equal(satoCall.method, "POST");
  assert.deepEqual(satoCall.body, { chain_in: "base", token_in: USDC, token_out: WETH, amount_in: "10000000", slippage_bps: 50, mode: "recommend" });
  const lifiUrl = new URL(f.calls.find((c) => isLifi(c.url))!.url);
  assert.equal(lifiUrl.searchParams.get("fromChain"), "8453");
  assert.equal(lifiUrl.searchParams.get("slippage"), "0.005");
});

for (const venue of ["direct", "lifi"]) {
  test(`swap.quote venue ${venue}: zero requests to satohub.ai`, async () => {
    const f = fakeFetch([{ match: isSato, body: SATO }, { match: isLifi, body: LIFI }]);
    const out = await swapQuote({ ...INPUT, venue }, ctxWith({ fetch: f.fetch }));
    assert.equal(f.calls.filter((c) => isSato(c.url)).length, 0);
    assert.deepEqual(out.quotes.map((q) => q.venue), ["lifi"]);
    assert.equal(out.quotes[0]!.sato_fee_bps, 0);
  });
}

test("swap.quote keeps a failed Sato answer visible instead of dropping it", async () => {
  const f = fakeFetch([{ match: isSato, status: 503, body: { error: "down" } }, { match: isLifi, body: LIFI }]);
  const out = await swapQuote(INPUT, ctxWith({ fetch: f.fetch }));
  assert.equal(out.quotes[0]!.venue, "sato");
  assert.match(out.quotes[0]!.error!, /^http_503/);
  assert.equal(out.quotes[0]!.sato_fee_bps, null);
  assert.equal(out.quotes[1]!.error, null);
});

test("swap.quote venue 0x: clear error without a key, and no request is made", async () => {
  const f = fakeFetch([]);
  await assert.rejects(swapQuote({ ...INPUT, venue: "0x" }, ctxWith({ fetch: f.fetch })), ActionInputError);
  assert.equal(f.calls.length, 0);
});

test("swap.quote venue 0x with a key calls only 0x and passes its fees through", async () => {
  const zx = { liquidityAvailable: true, buyAmount: "3700000000000000", minBuyAmount: "3680000000000000", fees: { integratorFee: null, zeroExFee: { amount: "1500", token: USDC, type: "volume" }, gasFee: null }, route: { fills: [{ source: "Uniswap_V3" }] } };
  const f = fakeFetch([{ match: isZeroex, body: zx }]);
  const out = await swapQuote({ ...INPUT, venue: "0x", zeroex_api_key: "test-key" }, ctxWith({ fetch: f.fetch }));
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0]!.url.startsWith("https://api.0x.org/swap/allowance-holder/price?"));
  assert.equal(f.calls[0]!.headers["0x-api-key"], "test-key");
  assert.deepEqual(out.quotes[0]!.upstream_fees, zx.fees);
  assert.equal(out.quotes[0]!.sato_fee_bps, 0);
});

function allowanceClient(allowance: bigint) {
  return fakeClient({ readContract: async (a: { functionName: string }) => { assert.equal(a.functionName, "allowance"); return allowance; } });
}

test("swap.prepare sato: swap tx, Sato disclosure verbatim, direct quote available", async () => {
  const f = fakeFetch([{ match: isSato, body: SATO_TX }, { match: isLifi, body: LIFI }]);
  const { client } = allowanceClient(10n ** 30n);
  const b = await buildSwapPrepare({ ...INPUT, taker: TAKER }, ctxWith({ fetch: f.fetch, client }));
  assert.equal(b.unsigned.kind, "evm_tx");
  assert.equal((b.unsigned as { to: string }).to, SATO_TX.tx.to);
  assert.equal((b.unsigned as { data: string }).data, SATO_TX.tx.data);
  assert.deepEqual(b.fee_disclosure, { venue: "sato", fee_bps: SATO_TX.sato_fee_bps, fee_recipient: SATO_TX.sato_fee_recipient, statement: SATO_TX.disclosure, direct_quote_available: true });
  assert.equal((b.params as { step: string }).step, "swap");
  assert.equal(b.facts.usd_value, 10); // USDC sell leg, 10000000 / 10^6 (M1 pricing fix)
  assert.equal(b.facts.venue, "sato");
  const body = f.calls.find((c) => isSato(c.url))!.body as Record<string, unknown>;
  assert.equal(body.mode, "build-tx");
  assert.equal(body.taker, TAKER);
  assert.doesNotMatch(b.summary, /\bbest\b|recommended|safe/i);
});

test("swap.prepare: short allowance prepares the exact-amount approve first", async () => {
  const f = fakeFetch([{ match: isSato, body: SATO_TX }, { match: isLifi, body: LIFI }]);
  const { client } = allowanceClient(0n);
  const b = await buildSwapPrepare({ ...INPUT, taker: TAKER }, ctxWith({ fetch: f.fetch, client }));
  const u = b.unsigned as { to: string; data: `0x${string}`; value: string };
  assert.equal(u.to, USDC);
  assert.equal(u.value, "0");
  const dec = decodeFunctionData({ abi: erc20Abi, data: u.data });
  assert.equal(dec.functionName, "approve");
  assert.deepEqual(dec.args, [SATO_TX.tx.approval_target, 10000000n]);
  assert.equal((b.params as { step: string }).step, "approve");
  assert.match(b.summary, /^Approve /);
});

for (const venue of ["direct", "lifi"]) {
  test(`swap.prepare venue ${venue}: LI.FI tx, no Sato call, no Sato fee`, async () => {
    const f = fakeFetch([{ match: isSato, body: SATO_TX }, { match: isLifi, body: LIFI }]);
    const { client } = allowanceClient(10n ** 30n);
    const b = await buildSwapPrepare({ ...INPUT, taker: TAKER, venue }, ctxWith({ fetch: f.fetch, client }));
    assert.equal(f.calls.filter((c) => isSato(c.url)).length, 0);
    assert.equal((b.unsigned as { to: string }).to, LIFI.transactionRequest.to);
    assert.equal(b.fee_disclosure!.venue, "lifi");
    assert.equal(b.fee_disclosure!.fee_bps, null);
    assert.ok(b.fee_disclosure!.statement.startsWith(NO_SATO_FEE_STATEMENT));
    assert.equal(b.fee_disclosure!.direct_quote_available, true);
    assert.equal(b.facts.usd_value, Number(LIFI.estimate.fromAmountUSD));
  });
}

test("swap.prepare needs a taker and refuses a withheld Sato tx", async () => {
  await assert.rejects(buildSwapPrepare(INPUT, ctxWith()), ActionInputError);
  const f = fakeFetch([{ match: isSato, body: SATO }, { match: isLifi, body: LIFI }]);
  await assert.rejects(buildSwapPrepare({ ...INPUT, taker: TAKER }, ctxWith({ fetch: f.fetch })), /no executable transaction — withheld/);
});
