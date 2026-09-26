import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { evaluatePreflight } from "../src/policy/index.js";
import { POLICY_DEFAULTS, POLICY_RULE_IDS, parsePolicyFile, type SatoPolicy } from "../src/spec/index.js";
import type { PreflightFacts } from "../src/types.js";

const RUNS = { numRuns: 300, seed: 42 };
const SIM = { ok: true, method: "eth_call", block: "1", gas_estimate: "21000", error: null, as_of: "2026-09-26T00:00:00Z" };
const policy = (p: Partial<SatoPolicy> = {}): SatoPolicy => ({ schema: "sato.policy/v1", version: 1, ...POLICY_DEFAULTS, ...p });
const facts = (f: Partial<PreflightFacts> = {}): PreflightFacts => ({
  action: "swap.prepare", chain: "base-sepolia", network: "testnet", usd_value: 10, usd_spent_today: 0, simulation: SIM, ttl_s: 60, ...f,
});
const rules = (r: { refusals: { rule: string }[] }) => r.refusals.map((x) => x.rule);

test("default policy passes a simulated testnet intent", () => {
  assert.deepEqual(evaluatePreflight(policy(), facts()), { ok: true, refusals: [] });
});

test("mainnet refused unless policy network is mainnet", () => {
  assert.deepEqual(rules(evaluatePreflight(policy(), facts({ network: "mainnet", chain: "base" }))), ["network_mainnet_not_enabled"]);
  assert.equal(evaluatePreflight(policy({ network: "mainnet" }), facts({ network: "mainnet", chain: "base" })).ok, true);
});

test("allowlists: empty = any, case-insensitive, chain-qualified", () => {
  const p = policy({ allow_chains: ["base"], allow_tokens: ["base-sepolia:USDC"], allow_contracts: ["base-sepolia:0xAbC"],
    allow_recipients: ["base-sepolia:0xdef"], allow_venues: ["uniswap"] });
  const r = evaluatePreflight(p, facts({ token: "usdc", contract: "0xabc", recipient: "0xDEF", venue: "Uniswap" }));
  assert.deepEqual(rules(r), ["chain_allowlist"]);
  const r2 = evaluatePreflight(p, facts({ chain: "base", token: "WETH", contract: "0x1", recipient: "0x2", venue: "sato" }));
  assert.deepEqual(rules(r2), ["contract_allowlist", "recipient_allowlist", "token_allowlist", "venue_allowlist"]);
});

test("USD caps, unknown price and unknown spend", () => {
  assert.deepEqual(rules(evaluatePreflight(policy({ max_usd_per_trade: 5 }), facts())), ["max_usd_per_trade"]);
  assert.deepEqual(rules(evaluatePreflight(policy({ max_usd_per_trade: 5, max_usd_per_day: 5 }), facts({ usd_value: null }))), ["unknown_price"]);
  assert.deepEqual(rules(evaluatePreflight(policy({ max_usd_per_day: 50 }), facts({ usd_value: null }))), ["unknown_price"]);
  assert.deepEqual(rules(evaluatePreflight(policy({ max_usd_per_day: 50 }), facts({ usd_spent_today: null }))), ["unknown_verdict"]);
  assert.deepEqual(rules(evaluatePreflight(policy({ max_usd_per_day: 50 }), facts({ usd_spent_today: 45 }))), ["max_usd_per_day"]);
  assert.equal(evaluatePreflight(policy({ max_usd_per_trade: 5, unknown_verdict: "allow" }), facts({ usd_value: null })).ok, true);
  const u = evaluatePreflight(policy({ max_usd_per_trade: 5 }), facts({ usd_value: null })).refusals[0];
  assert.equal(u!.observed, "unknown");
});

test("max_per_trade compares base units as BigInt", () => {
  const p = policy({ max_per_trade: { "base-sepolia:USDC": "100000000000000000000000" } });
  assert.equal(evaluatePreflight(p, facts({ token: "USDC", token_amount_base_units: "100000000000000000000000" })).ok, true);
  const r = evaluatePreflight(p, facts({ token: "usdc", token_amount_base_units: "100000000000000000000001" }));
  assert.deepEqual(rules(r), ["max_per_trade"]);
  assert.deepEqual(rules(evaluatePreflight(p, facts({ token: "USDC" }))), ["unknown_verdict"]);
});

test("slippage, ttl, simulation", () => {
  assert.deepEqual(rules(evaluatePreflight(policy({ max_slippage_bps: 50 }), facts({ slippage_bps: 51 }))), ["max_slippage_bps"]);
  assert.deepEqual(rules(evaluatePreflight(policy({ intent_ttl_s: 30 }), facts())), ["intent_ttl"]);
  assert.deepEqual(rules(evaluatePreflight(policy(), facts({ simulation: null }))), ["simulation_required"]);
  const f = evaluatePreflight(policy(), facts({ simulation: { ...SIM, ok: false, error: "execution reverted" } }));
  assert.deepEqual(rules(f), ["simulation_failed"]);
  assert.equal(f.refusals[0]!.observed, "execution reverted");
});

// ── properties ───────────────────────────────────────────────────────────────
const addr = fc.constantFrom("0xaaa", "0xbbb", "0xccc");
const arbPolicy = fc.record({
  network: fc.constantFrom("fork", "testnet", "mainnet"),
  allow_chains: fc.subarray(["base", "base-sepolia", "ethereum"]),
  allow_tokens: fc.subarray(["base:USDC", "base-sepolia:USDC", "base:WETH"]),
  allow_contracts: fc.subarray(["base:0xaaa", "base-sepolia:0xbbb"]),
  allow_recipients: fc.subarray(["base:0xccc", "base-sepolia:0xaaa"]),
  allow_venues: fc.subarray(["uniswap", "kyberswap"]),
  max_usd_per_trade: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: null }),
  max_usd_per_day: fc.option(fc.integer({ min: 1, max: 5000 }), { nil: null }),
  max_per_trade: fc.dictionary(fc.constantFrom("base:USDC", "base-sepolia:USDC"), fc.bigInt({ min: 0n, max: 10n ** 30n }).map(String)),
  max_slippage_bps: fc.option(fc.integer({ min: 0, max: 5000 }), { nil: null }),
  intent_ttl_s: fc.integer({ min: 1, max: 3600 }),
  unknown_verdict: fc.constantFrom("refuse", "allow"),
  human_approval: fc.boolean(),
}).map((p) => {
  const r = parsePolicyFile({ schema: "sato.policy/v1", ...p });
  if (!r.ok) throw new Error(r.error);
  return r.policy;
});
const arbFacts = fc.record({
  action: fc.constant("swap.prepare"),
  chain: fc.constantFrom("base", "base-sepolia", "ethereum"),
  network: fc.constantFrom("fork", "testnet", "mainnet"),
  token: fc.option(fc.constantFrom("USDC", "WETH"), { nil: undefined }),
  token_amount_base_units: fc.option(fc.bigInt({ min: 0n, max: 10n ** 31n }).map(String), { nil: undefined }),
  usd_value: fc.option(fc.double({ min: 0, max: 10000, noNaN: true }), { nil: null }),
  usd_spent_today: fc.option(fc.double({ min: 0, max: 10000, noNaN: true }), { nil: null }),
  contract: fc.option(addr, { nil: undefined }),
  recipient: fc.option(addr, { nil: undefined }),
  venue: fc.option(fc.constantFrom("uniswap", "kyberswap", "sato", "0x"), { nil: undefined }),
  slippage_bps: fc.option(fc.integer({ min: 0, max: 10000 }), { nil: undefined }),
  simulation: fc.option(fc.record({ ok: fc.boolean(), method: fc.constant("eth_call"), block: fc.constant("1"),
    gas_estimate: fc.constant(null), error: fc.option(fc.constant("reverted"), { nil: null }), as_of: fc.constant("2026-09-26T00:00:00Z") }), { nil: null }),
  ttl_s: fc.integer({ min: -5, max: 4000 }),
}) as fc.Arbitrary<PreflightFacts>;

test("property: ok iff no refusals; every refusal is complete and sorted", () => {
  fc.assert(fc.property(arbPolicy, arbFacts, (p, f) => {
    const r = evaluatePreflight(p, f);
    assert.equal(r.ok, r.refusals.length === 0);
    for (const x of r.refusals) {
      assert.ok(POLICY_RULE_IDS.includes(x.rule));
      for (const k of ["limit", "observed", "message"] as const) assert.ok(typeof x[k] === "string" && x[k].length > 0);
    }
    const ids = rules(r);
    assert.deepEqual(ids, [...ids].sort());
  }), RUNS);
});

test("property: deterministic", () => {
  fc.assert(fc.property(arbPolicy, arbFacts, (p, f) => {
    assert.deepEqual(evaluatePreflight(p, f), evaluatePreflight(structuredClone(p), structuredClone(f)));
  }), RUNS);
});

test("property: unknown USD never passes a USD cap under the default verdict", () => {
  fc.assert(fc.property(arbPolicy, arbFacts, fc.integer({ min: 1, max: 1000 }), (p, f, cap) => {
    const r = evaluatePreflight({ ...p, unknown_verdict: "refuse", max_usd_per_trade: cap }, { ...f, usd_value: null });
    assert.equal(r.ok, false);
    assert.ok(rules(r).includes("unknown_price"));
  }), RUNS);
});

test("property: increasing an amount never turns a refusal into a pass", () => {
  fc.assert(fc.property(arbPolicy, arbFacts, fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.double({ min: 0, max: 1000, noNaN: true }),
    (p, f, dAmt, dUsd) => {
      const before = evaluatePreflight(p, f);
      const bigger: PreflightFacts = { ...f,
        token_amount_base_units: f.token_amount_base_units === undefined ? undefined : String(BigInt(f.token_amount_base_units) + dAmt),
        usd_value: f.usd_value === null ? null : f.usd_value + dUsd };
      if (!before.ok) assert.equal(evaluatePreflight(p, bigger).ok, false);
    }), RUNS);
});

test("property: venue neutrality — a Sato venue and any other venue get identical results", () => {
  fc.assert(fc.property(arbPolicy, arbFacts, fc.constantFrom("uniswap", "kyberswap", "0x", "direct", "jupiter"), (p, f, other) => {
    const pol = { ...p, allow_venues: [] as string[] };
    const a = evaluatePreflight(pol, { ...f, venue: "sato" });
    const b = evaluatePreflight(pol, { ...f, venue: other });
    assert.deepEqual(a, b);
    // with an explicit allowlist, only venue_allowlist may differ
    const strip = (r: typeof a) => r.refusals.filter((x) => x.rule !== "venue_allowlist");
    assert.deepEqual(strip(evaluatePreflight(p, { ...f, venue: "sato" })), strip(evaluatePreflight(p, { ...f, venue: other })));
  }), RUNS);
});
