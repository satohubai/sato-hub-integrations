import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { compileCdpPolicy, CDP_NETWORKS, EVM_CHAIN_IDS, type CdpRule } from "../src/policy/index.js";
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
    // chain-scoped: one send rule per chain, no sign rule (sign carries no network)
    rules: [
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
  assert.deepEqual(r.document.rules[0]!.criteria, [{ type: "evmNetwork", networks: ["base"], operator: "in" }]);
  const s = compileCdpPolicy(pol({ allow_chains: ["solana"] }), { address: ME });
  assert.ok(s.document.rules.every((x) => x.action === "reject"));
});

test("per-chain rules: an address allowed on one chain is not admitted on another", () => {
  const p = pol({ allow_chains: ["base", "ethereum"], allow_recipients: [`base:${A}`, `ethereum:${B}`], max_per_trade: { "base:ETH": "5" } });
  const r = compileCdpPolicy(p, { address: ME });
  assert.deepEqual(r.document.rules, [
    { action: "accept", operation: "sendEvmTransaction", criteria: [{ type: "evmAddress", addresses: [B], operator: "in" }, { type: "evmNetwork", networks: ["ethereum"], operator: "in" }] },
    { action: "accept", operation: "sendEvmTransaction", criteria: [{ type: "ethValue", ethValue: "5", operator: "<=" }, { type: "evmAddress", addresses: [A], operator: "in" }, { type: "evmNetwork", networks: ["base"], operator: "in" }] },
  ]);
  const s = compileCdpPolicy(pol({ allow_chains: ["base-sepolia"] }), { address: ME, network: "sepolia" });
  assert.ok(s.document.rules.every((x) => x.action === "reject"));
  assert.ok(s.not_compiled.some((x) => x.field === "allow_chains" && /outside allow_chains/.test(x.reason)));
});

// Minimal CDP evaluator: does any accept rule admit tx? A sign rule has no network, so it admits on every chain.
type Tx = { to: string; chain: string; value: bigint };
function cdpAdmits(rules: CdpRule[], tx: Tx): boolean {
  const net = CDP_NETWORKS[tx.chain as keyof typeof CDP_NETWORKS];
  return rules.some((r) => r.action === "accept" && r.criteria.every((c) => {
    if (c.type === "ethValue") return tx.value <= BigInt(c.ethValue);
    if (c.type === "evmAddress") return c.addresses.includes(tx.to as `0x${string}`);
    return net !== undefined && c.networks.includes(net);
  }));
}

test("property: a compiled CDP document never admits an address or chain the policy refuses", () => {
  const pool = Array.from({ length: 8 }, (_, i) => "0x" + String(i + 1).repeat(40).slice(0, 40));
  const evm = Object.keys(EVM_CHAIN_IDS);
  fc.assert(
    fc.property(
      fc.subarray(evm),
      fc.array(fc.tuple(fc.constantFrom(...evm), fc.constantFrom(...pool)), { maxLength: 6 }),
      fc.array(fc.tuple(fc.constantFrom(...evm), fc.constantFrom(...pool)), { maxLength: 6 }),
      fc.constantFrom(...pool),
      fc.constantFrom(...evm),
      fc.bigInt({ min: 0n, max: 10n ** 20n }),
      fc.option(fc.tuple(fc.constantFrom(...evm), fc.bigInt({ min: 0n, max: 10n ** 20n })), { nil: undefined }),
      fc.option(fc.constantFrom(...evm), { nil: undefined }),
      (chains, contracts, recipients, probe, probeChain, value, cap, network) => {
        const p = pol({
          network: "testnet",
          allow_chains: chains,
          allow_contracts: contracts.map(([c, a]) => `${c}:${a}`),
          allow_recipients: recipients.map(([c, a]) => `${c}:${a}`),
          max_per_trade: cap === undefined ? {} : { [`${cap[0]}:${cap[0] === "polygon" ? "POL" : "ETH"}`]: cap[1].toString() },
        });
        const listed = [...contracts, ...recipients];
        const refused =
          (chains.length > 0 && !chains.includes(probeChain)) ||
          (listed.length > 0 && !listed.some(([c, a]) => c === probeChain && a === probe)) ||
          (cap !== undefined && (cap[0] === probeChain || chains.length === 0) && value > cap[1]) ||
          (network !== undefined && probeChain !== network);
        const opts = network === undefined ? { address: ME } : { address: ME, network: network as Parameters<typeof compileCdpPolicy>[1]["network"] };
        const r = compileCdpPolicy(p, opts);
        if (refused) assert.equal(cdpAdmits(r.document.rules, { to: probe, chain: probeChain, value }), false);
        assert.ok(r.not_compiled.some((x) => x.field === "unknown_verdict"));
      },
    ),
    { numRuns: 1000, seed: 42 },
  );
});
