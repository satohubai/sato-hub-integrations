import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { compilePrivyPolicy, compileTurnkeyPolicy, EVM_CHAIN_IDS, type PrivyRule, type TurnkeyPolicy } from "../src/policy/index.js";
import { parsePolicyFile } from "../src/spec/index.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const T = "0x3333333333333333333333333333333333333333";
const ME = "0x9999999999999999999999999999999999999999" as const;

function pol(extra: Record<string, unknown>) {
  const r = parsePolicyFile({ schema: "sato.policy/v1", ...extra });
  if (!r.ok) throw new Error(r.error);
  return r.policy;
}

const FULL = {
  network: "testnet",
  allow_chains: ["base-sepolia", "solana-devnet"],
  allow_tokens: ["base-sepolia:USDC"],
  allow_contracts: [`base-sepolia:${B}`],
  allow_recipients: [`base-sepolia:${A}`, "base-sepolia:VAULT"],
  allow_venues: ["uniswap"],
  max_usd_per_trade: 50,
  max_usd_per_day: 200,
  max_per_trade: { "base-sepolia:ETH": "1000000000000000000", "base-sepolia:USDC": "50000000", [`base-sepolia:${T}`]: "5000000" },
  max_slippage_bps: 100,
};

type Tx = { to: string; chain_id: number; value: bigint };

// Minimal evaluators of the two documents, enough for the property: does any ALLOW admit tx?
function privyAdmits(rules: PrivyRule[], tx: Tx): boolean {
  const pass = (r: PrivyRule) => r.conditions.every((c) => {
    if (c.field_source !== "ethereum_transaction") return true;
    const v = c.field === "to" ? tx.to : c.field === "chain_id" ? String(tx.chain_id) : tx.value;
    if (c.operator === "in") return (c.value as string[]).includes(String(v));
    if (c.operator === "eq") return String(v) === c.value;
    return BigInt(v as bigint) <= BigInt(c.value as string);
  });
  return rules.some((r) => r.action === "ALLOW" && pass(r));
}
function turnkeyAdmits(ps: TurnkeyPolicy[], tx: Tx): boolean {
  const lit = (s: string) => (s.startsWith("'") ? s.slice(1, -1) : s);
  const clause = (c: string): boolean => {
    let m = /^eth\.tx\.(\w+) in \[(.*)\]$/.exec(c);
    if (m) return m[2]!.split(", ").map(lit).includes(String((tx as Record<string, unknown>)[m[1]!]));
    m = /^eth\.tx\.chain_id == (\d+)$/.exec(c);
    if (m) return tx.chain_id === Number(m[1]);
    m = /^eth\.tx\.value <= (\d+)$/.exec(c);
    if (m) return tx.value <= BigInt(m[1]!);
    if (c === "eth.tx.to != ''") return tx.to !== "";
    throw new Error("unmodelled clause " + c);
  };
  return ps.some((p) => p.effect === "EFFECT_ALLOW" && p.condition.split(" && ").every(clause));
}

test("privy snapshot", () => {
  const r = compilePrivyPolicy(pol(FULL), { address: ME });
  const base = [
    { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: "84532" },
    { field_source: "ethereum_transaction", field: "to", operator: "in", value: [A, B] },
    { field_source: "ethereum_transaction", field: "value", operator: "lte", value: "1000000000000000000" },
  ];
  assert.equal(r.document.name, "Sato policy for 0x99999999");
  assert.equal(r.document.chain_type, "ethereum");
  assert.deepEqual(r.document.rules.map((x) => [x.name, x.action]), [
    ["sato-allow-84532-0-eth_signTransaction", "ALLOW"],
    ["sato-allow-84532-0-eth_sendTransaction", "ALLOW"],
    ["sato-cap-base-sepolia-0x33333333-eth_signTransaction", "DENY"],
    ["sato-cap-base-sepolia-0x33333333-eth_sendTransaction", "DENY"],
  ]);
  assert.deepEqual(r.document.rules[0]!.conditions, base);
  assert.deepEqual(r.document.rules[2]!.conditions.map((c) => [c.field, c.operator, c.value]), [
    ["chain_id", "eq", "84532"], ["to", "eq", T], ["transfer.amount", "gt", "0x4c4b40"],
  ]);
  assert.deepEqual(r.not_compiled.map((x) => x.field), [
    "allow_chains", "allow_contracts", "allow_contracts", "allow_recipients", "allow_recipients", "allow_tokens", "allow_venues",
    "intent_ttl_s", "max_per_trade", "max_per_trade", "max_slippage_bps", "max_usd_per_day", "max_usd_per_trade", "network",
    "require_simulation", "unknown_verdict",
  ]);
  assert.deepEqual(compilePrivyPolicy(pol(FULL), { address: ME }), r, "deterministic");
});

test("turnkey snapshot", () => {
  const r = compileTurnkeyPolicy(pol(FULL), { address: ME });
  assert.deepEqual(r.document.policies.map((p) => [p.effect, p.condition]), [
    ["EFFECT_ALLOW", `eth.tx.chain_id == 84532 && eth.tx.to in ['${A}', '${B}'] && eth.tx.value <= 1000000000000000000`],
    ["EFFECT_DENY", `eth.tx.chain_id == 84532 && eth.tx.to == '${T}' && eth.tx.function_name == 'transfer' && eth.tx.contract_call_args['amount'] > 5000000`],
  ]);
  assert.ok(r.not_compiled.every((x) => x.reason.length > 0));
  assert.deepEqual(r.not_compiled.map((x) => x.field).filter((f) => f === "max_per_trade").length, 3);
  assert.deepEqual(compileTurnkeyPolicy(pol(FULL), { address: ME }), r, "deterministic");
});

test("fail closed: non-EVM-only chains or no expressible address -> no allow", () => {
  for (const extra of [{ allow_chains: ["solana"] }, { allow_recipients: ["base:VAULT"] }]) {
    assert.ok(compilePrivyPolicy(pol(extra), { address: ME }).document.rules.every((r) => r.action !== "ALLOW"));
    assert.ok(compileTurnkeyPolicy(pol(extra), { address: ME }).document.policies.every((p) => p.effect !== "EFFECT_ALLOW"));
  }
});

test("every constraining field is either compiled or listed", () => {
  for (const c of [compilePrivyPolicy, compileTurnkeyPolicy]) {
    const f = c(pol({ max_usd_per_trade: 5, max_usd_per_day: 5, human_approval: true }), { address: ME }).not_compiled.map((x) => x.field);
    for (const k of ["max_usd_per_trade", "max_usd_per_day", "human_approval", "unknown_verdict"]) assert.ok(f.includes(k), k);
  }
});

test("property: a compiled allowlist never admits an address or chain the policy refuses", () => {
  const pool = Array.from({ length: 8 }, (_, i) => "0x" + String(i + 1).repeat(40).slice(0, 40));
  const evm = Object.keys(EVM_CHAIN_IDS);
  fc.assert(
    fc.property(
      fc.subarray(evm),
      fc.subarray(pool),
      fc.subarray(pool),
      fc.constantFrom(...pool),
      fc.constantFrom(...evm),
      fc.bigInt({ min: 0n, max: 10n ** 20n }),
      fc.option(fc.bigInt({ min: 0n, max: 10n ** 20n }), { nil: undefined }),
      fc.option(fc.constantFrom(...evm), { nil: undefined }),
      (chains, contracts, recipients, probe, probeChain, value, cap, network) => {
        const scope = chains.length ? chains : [probeChain];
        const ch = scope[0]!;
        const p = pol({
          network: "testnet",
          allow_chains: chains,
          allow_contracts: contracts.map((a) => `${ch}:${a}`),
          allow_recipients: recipients.map((a) => `${ch}:${a}`),
          max_per_trade: cap === undefined ? {} : { [`${ch}:${ch === "polygon" ? "POL" : "ETH"}`]: cap.toString() },
        });
        const listed = new Set([...contracts, ...recipients]);
        const refused =
          (chains.length > 0 && !chains.includes(probeChain)) ||
          (listed.size > 0 && (!listed.has(probe) || probeChain !== ch)) ||
          (cap !== undefined && probeChain === ch && value > cap) ||
          (network !== undefined && probeChain !== network);
        const tx = { to: probe, chain_id: EVM_CHAIN_IDS[probeChain]!, value };
        const opts = network === undefined ? { address: ME } : { address: ME, network: network as Parameters<typeof compilePrivyPolicy>[1]["network"] };
        if (refused) {
          assert.equal(privyAdmits(compilePrivyPolicy(p, opts).document.rules, tx), false);
          assert.equal(turnkeyAdmits(compileTurnkeyPolicy(p, opts).document.policies, tx), false);
        }
      },
    ),
    { numRuns: 500, seed: 42 },
  );
});

test("fail closed: target network outside a non-empty allow_chains -> deny-all", () => {
  const p = pol({ allow_chains: ["base-sepolia"] });
  const pr = compilePrivyPolicy(p, { address: ME, network: "sepolia" });
  assert.ok(pr.document.rules.every((r) => r.action !== "ALLOW"));
  assert.ok(pr.not_compiled.some((x) => x.field === "allow_chains" && /outside allow_chains/.test(x.reason)));
  const tk = compileTurnkeyPolicy(p, { address: ME, network: "sepolia" });
  assert.ok(tk.document.policies.every((x) => x.effect !== "EFFECT_ALLOW"));
  for (const chain_id of [1, 11155111, 84532]) {
    const tx = { to: A, chain_id, value: 0n };
    assert.equal(privyAdmits(pr.document.rules, tx), false);
    assert.equal(turnkeyAdmits(tk.document.policies, tx), false);
  }
  const p2 = pol({ allow_chains: ["base-sepolia"], allow_recipients: [`sepolia:${A}`, `base-sepolia:${B}`] });
  assert.ok(compilePrivyPolicy(p2, { address: ME, network: "sepolia" }).document.rules.every((r) => r.action !== "ALLOW"));
  assert.ok(compileTurnkeyPolicy(p2, { address: ME, network: "sepolia" }).document.policies.every((x) => x.effect !== "EFFECT_ALLOW"));
});
