import { test } from "node:test";
import assert from "node:assert/strict";
import { compileCdpPolicy } from "../src/policy/index.js";
import { parsePolicyFile } from "../src/spec/index.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const ME = "0x9999999999999999999999999999999999999999" as const;

function pol(extra: Record<string, unknown>) {
  const r = parsePolicyFile({ schema: "sato.policy/v1", ...extra });
  if (!r.ok) throw new Error(r.error);
  return r.policy;
}

test("snapshot: compiled document and not_compiled list", () => {
  const p = pol({
    network: "testnet",
    allow_chains: ["base-sepolia", "solana-devnet"],
    allow_tokens: ["base-sepolia:USDC"],
    allow_contracts: [`base-sepolia:${B}`],
    allow_recipients: [`base-sepolia:${A}`, "base-sepolia:VAULT"],
    allow_venues: ["uniswap"],
    max_usd_per_trade: 50,
    max_usd_per_day: 200,
    max_per_trade: { "base-sepolia:ETH": "1000000000000000000", "base-sepolia:USDC": "50000000" },
    max_slippage_bps: 100,
  });
  const r = compileCdpPolicy(p, { address: ME });
  const crit = [
    { type: "ethValue", ethValue: "1000000000000000000", operator: "<=" },
    { type: "evmAddress", addresses: [A, B], operator: "in" },
  ];
  assert.deepEqual(r.document, {
    scope: "account",
    description: "Sato policy for 0x99999999",
    rules: [
      { action: "accept", operation: "signEvmTransaction", criteria: crit },
      { action: "accept", operation: "sendEvmTransaction", criteria: [...crit, { type: "evmNetwork", networks: ["base-sepolia"], operator: "in" }] },
    ],
  });
  assert.deepEqual(r.not_compiled.map((x) => x.field), [
    "allow_chains", "allow_chains", "allow_contracts", "allow_recipients", "allow_recipients", "allow_tokens", "allow_venues",
    "intent_ttl_s", "max_per_trade", "max_slippage_bps", "max_usd_per_day", "max_usd_per_trade", "network",
    "require_simulation", "unknown_verdict",
  ]);
  assert.ok(r.not_compiled.every((x) => x.reason.length > 0));
  assert.deepEqual(compileCdpPolicy(p, { address: ME }), r, "deterministic");
});

test("every constraining field is either compiled or listed", () => {
  const r = compileCdpPolicy(pol({ max_usd_per_trade: 5, max_usd_per_day: 5, human_approval: true }), { address: ME });
  const f = r.not_compiled.map((x) => x.field);
  for (const k of ["max_usd_per_trade", "max_usd_per_day", "human_approval"]) assert.ok(f.includes(k), k);
});

test("network option scopes the document; an unmapped-only chain set rejects instead of widening", () => {
  const p = pol({ allow_chains: ["base", "base-sepolia"] });
  const r = compileCdpPolicy(p, { address: ME, network: "base" });
  assert.deepEqual(r.document.rules[1]!.criteria, [{ type: "evmNetwork", networks: ["base"], operator: "in" }]);
  const s = compileCdpPolicy(pol({ allow_chains: ["solana"] }), { address: ME });
  assert.ok(s.document.rules.every((x) => x.action === "reject"));
});
