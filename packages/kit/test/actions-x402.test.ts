import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionRefusedError, buildX402Prepare } from "../src/actions/index.js";
import { DEFAULT_POLICY, TEST_UA, ctxWith, fakeFetch, fixture } from "./fixtures/actions-harness.js";

const V2 = fixture("x402-v2-payment-required.json");
const V1 = fixture("x402-v1-body.json");
const URL_ = "https://api.example.com/premium-data";

test("x402.prepare v2: reads the PAYMENT-REQUIRED header", async () => {
  const f = fakeFetch([{ match: (u) => u === URL_, status: 402, body: {}, headers: { "PAYMENT-REQUIRED": V2.header } }]);
  const b = await buildX402Prepare({ url: URL_, max_amount_base_units: "20000" }, ctxWith({ fetch: f.fetch }));
  const a = V2.decoded.accepts[0];
  assert.deepEqual(b.unsigned, { kind: "x402_payment", network: a.network, resource: V2.decoded.resource.url, pay_to: a.payTo, asset: a.asset, amount: a.amount });
  assert.equal(b.facts.chain, "base-sepolia");
  assert.equal(b.facts.usd_value, 0.01);
  assert.equal(b.fee_disclosure, null);
  assert.equal(f.calls[0]!.headers["user-agent"], TEST_UA);
});

test("x402.prepare v1: reads accepts from the JSON body", async () => {
  const f = fakeFetch([{ match: () => true, status: 402, body: V1 }]);
  const b = await buildX402Prepare({ url: "https://api.example.com/v1-data", max_amount_base_units: "50000" }, ctxWith({ fetch: f.fetch }));
  assert.equal(b.unsigned.kind, "x402_payment");
  assert.equal((b.unsigned as { amount: string }).amount, "50000");
  assert.equal(b.facts.chain, "base");
});

test("x402.prepare refuses when nothing fits, naming each rule", async () => {
  const f = fakeFetch([{ match: () => true, status: 402, body: V1 }]);
  const policy = { ...DEFAULT_POLICY, allow_chains: ["ethereum"] };
  await assert.rejects(
    buildX402Prepare({ url: "https://api.example.com/v1-data", max_amount_base_units: "100" }, ctxWith({ fetch: f.fetch, policy })),
    (e: unknown) => {
      assert.ok(e instanceof ActionRefusedError);
      assert.deepEqual(e.refusals.map((r) => r.rule).sort(), ["chain_allowlist", "max_per_trade"]);
      assert.equal(e.refusals.find((r) => r.rule === "max_per_trade")!.observed, "50000");
      return true;
    },
  );
});

test("x402.prepare: a non-402 answer is an error, not a payment", async () => {
  const f = fakeFetch([{ match: () => true, status: 200, body: { ok: true } }]);
  await assert.rejects(buildX402Prepare({ url: URL_, max_amount_base_units: "1" }, ctxWith({ fetch: f.fetch })), /not 402/);
});
