// The four parts together: CORE_ACTIONS + the real pre-flight + the real
// simulateTx + viemLocalSigner over a fake base fork (chain id 31337).
// Offline: a fake fetch serves the recorded swap fixtures and a fake EIP-1193
// transport stands in for the fork. The key is generated in memory and never funded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, custom, keccak256, parseTransaction, recoverTransactionAddress, type PublicClient } from "viem";
import { CORE_ACTIONS, createKit, parsePolicyFile, viemLocalSigner } from "../src/index.js";
import type { SatoPolicy } from "../src/spec/index.js";
import type { RpcProvider } from "../src/types.js";
import { FIXED_NOW, fakeFetch, fixture } from "./fixtures/actions-harness.js";

const SATO_TX = fixture("sato-swap-build-tx.base.json");
const LIFI = fixture("lifi-quote.base.json");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const MAX_UINT = "0x" + "f".repeat(64);

function fork() {
  const sent: string[] = [];
  const methods: string[] = [];
  const request = async ({ method, params }: { method: string; params?: any[] }) => {
    methods.push(method);
    switch (method) {
      case "eth_chainId": return "0x7a69"; // 31337: anvil --chain-id 31337 --fork-url <base>
      case "eth_blockNumber": return "0x10";
      case "eth_call": return MAX_UINT; // allowance(): plenty; the swap call: no revert
      case "eth_estimateGas": return "0x30d40";
      case "eth_getTransactionCount": return "0x0";
      case "eth_gasPrice": return "0x3b9aca00";
      case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x3b9aca00", number: "0x10", hash: "0x" + "11".repeat(32), timestamp: "0x1", transactions: [] };
      case "eth_sendRawTransaction": sent.push(params![0]); return keccak256(params![0]);
      default: throw Object.assign(new Error("fake fork: method not found " + method), { code: -32601 });
    }
  };
  const client = createPublicClient({ transport: custom({ request }) }) as PublicClient;
  const rpc: RpcProvider = () => client;
  return { rpc, sent, methods };
}

function policy(extra: Record<string, unknown> = {}): SatoPolicy {
  const p = parsePolicyFile({ schema: "sato.policy/v1", version: 1, network: "fork", allow_chains: ["base"], ...extra });
  if (!p.ok) throw new Error(p.error);
  return p.policy;
}

async function setup(pol: SatoPolicy) {
  const f = fork();
  const signer = viemLocalSigner({ generate: true, rpc: f.rpc, fork: true });
  const taker = await signer.address("base");
  const http = fakeFetch([
    { match: (u) => u.startsWith("https://satohub.ai/"), body: SATO_TX },
    { match: (u) => u.startsWith("https://li.quest/"), body: LIFI },
  ]);
  let now = FIXED_NOW;
  const kit = createKit({
    actions: CORE_ACTIONS.list(),
    policy: pol,
    signer,
    rpc: f.rpc,
    fetch: http.fetch,
    clock: () => now,
    secret: new Uint8Array(32).fill(3),
  });
  const input = { chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "10000000", slippage_bps: 50, taker };
  return { kit, f, http, taker, input, advance: (ms: number) => { now += ms; } };
}

test("integration: a policy refusal names its rule, limit and observed value, and cannot execute", async () => {
  const { kit, f, input } = await setup(policy({ max_slippage_bps: 10 }));
  const intent = await kit.prepare("swap.prepare", input);
  assert.equal(intent.policy.ok, false);
  const r = intent.policy.refusals.find((x) => x.rule === "max_slippage_bps");
  assert.ok(r, JSON.stringify(intent.policy.refusals));
  assert.equal(r!.limit, "10");
  assert.equal(r!.observed, "50");
  assert.ok(intent.simulation?.ok, "simulated with the real simulateTx before the pre-flight");
  await assert.rejects(kit.execute({ intent_id: intent.intent_id }), /refused by the policy pre-flight: max_slippage_bps \(limit 10, observed 50\)/);
  assert.equal(f.sent.length, 0);
  const log = await kit.receipts.read();
  assert.deepEqual(log.map((x) => x.status), ["refused"]);
});

test("integration: allowed swap executes exactly once and the receipt chain verifies", async () => {
  const { kit, f, http, taker, input } = await setup(policy());
  const intent = await kit.prepare("swap.prepare", input);
  assert.deepEqual(intent.policy, { ok: true, refusals: [] });
  assert.equal(intent.simulation?.ok, true);
  assert.equal(intent.simulation?.gas_estimate, String(0x30d40));
  assert.equal(intent.fee_disclosure?.venue, "sato");
  assert.equal(intent.fee_disclosure?.statement, SATO_TX.disclosure);
  assert.equal(intent.fee_disclosure?.direct_quote_available, true);
  assert.ok(http.calls.some((c) => c.url.startsWith("https://li.quest/")), "a no-Sato-fee quote is fetched alongside");
  assert.ok(f.methods.includes("eth_call") && f.methods.includes("eth_estimateGas"));

  const receipt = await kit.execute({ intent_id: intent.intent_id });
  assert.equal(receipt.status, "executed");
  assert.equal(f.sent.length, 1);
  assert.equal(receipt.tx_hash, keccak256(f.sent[0] as `0x${string}`));
  const parsed = parseTransaction(f.sent[0] as `0x${string}`);
  assert.equal(parsed.chainId, 31337, "signed for the fork, not replayable on base");
  assert.equal(parsed.to?.toLowerCase(), String(SATO_TX.tx.to).toLowerCase());
  assert.equal(parsed.data, SATO_TX.tx.data);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: f.sent[0] as any }), taker);
  assert.equal(receipt.mandate.intent_id, intent.intent_id);

  await assert.rejects(kit.execute({ intent_id: intent.intent_id }), /already executed/);
  assert.equal(f.sent.length, 1, "a second execute sends nothing");

  const log = await kit.receipts.read();
  assert.deepEqual(log.map((x) => [x.seq, x.status]), [[0, "prepared"], [1, "executed"]]);
  assert.equal(log[1]!.prev_hash, log[0]!.hash);
  assert.deepEqual(await kit.receipts.verify(), { ok: true, broken_at: null });
});

test("integration: execute takes only { intent_id }; an extra key such as `to` is rejected", async () => {
  const { kit, f, input } = await setup(policy());
  const intent = await kit.prepare("swap.prepare", input);
  await assert.rejects(kit.execute({ intent_id: intent.intent_id, to: "0x000000000000000000000000000000000000dEaD" } as any));
  assert.equal(f.sent.length, 0);
  // The intent is still intact and executes once with the plain request.
  const receipt = await kit.execute({ intent_id: intent.intent_id });
  assert.equal(receipt.status, "executed");
  assert.equal(f.sent.length, 1);
});

test("integration: venue direct never contacts Sato and discloses no Sato fee", async () => {
  const { kit, http, input } = await setup(policy());
  const intent = await kit.prepare("swap.prepare", { ...input, venue: "direct" });
  assert.equal(http.calls.filter((c) => c.url.startsWith("https://satohub.ai/")).length, 0);
  assert.equal(intent.fee_disclosure?.venue, "lifi");
  assert.equal(intent.policy.ok, true);
});

test("integration: x402.prepare is not refused for lacking a simulation, and a build refusal keeps its rules", async () => {
  const V2 = fixture("x402-v2-payment-required.json");
  const url = "https://api.example.com/premium-data";
  const f = fork();
  const http = fakeFetch([{ match: (u) => u === url, status: 402, body: {}, headers: { "PAYMENT-REQUIRED": V2.header } }]);
  const kit = createKit({ actions: CORE_ACTIONS.list(), policy: policy({ allow_chains: [] }), rpc: f.rpc, fetch: http.fetch, clock: () => FIXED_NOW, secret: new Uint8Array(32).fill(4) });
  const intent = await kit.prepare("x402.prepare", { url, max_amount_base_units: "20000" });
  assert.equal(intent.unsigned.kind, "x402_payment");
  assert.equal(intent.simulation, null);
  assert.ok(!intent.policy.refusals.some((r) => r.rule === "simulation_required"), JSON.stringify(intent.policy.refusals));
  assert.equal(intent.policy.ok, true);
  await assert.rejects(kit.execute({ intent_id: intent.intent_id }), /no signer configured|EVM transactions only/);

  await assert.rejects(kit.prepare("x402.prepare", { url, max_amount_base_units: "1" }), (e: any) => {
    assert.match(e.message, /refused before an intent was built: max_per_trade/);
    assert.ok(Array.isArray(e.refusals) && e.refusals[0].rule === "max_per_trade");
    return true;
  });
});
