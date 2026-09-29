// fromAgentKitProvider: real @coinbase/agentkit providers consumed end to end
// on a fake viem transport. Nothing here touches the network.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  createPublicClient, custom, decodeFunctionData, encodeFunctionResult, erc20Abi, parseAbi,
} from "viem";
import type { PublicClient } from "viem";
import { base } from "viem/chains";
import { ActionProvider, erc20ActionProvider, wethActionProvider } from "@coinbase/agentkit";
import type { Action, WalletProvider } from "@coinbase/agentkit";
import { z as z3 } from "zod/v3";
import { createKit } from "../src/kit.js";
import { DEFAULT_TOOL_NAMES, coreActions, toolDefinitions } from "../src/index.js";
import { fromAgentKitProvider, AGENTKIT_PIN } from "../src/adapters/agentkit.js";
import { lintActionDescriptor, parsePolicyFile } from "../src/spec/index.js";
import type { SatoPolicy, UnsignedEvmTx } from "../src/spec/index.js";
import type { Signer } from "../src/types.js";
import { PKG_ROOT } from "./fixtures/actions-harness.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const DEST = "0x2222222222222222222222222222222222222222";
const ME = "0x0000000000000000000000000000000000000001";
const SECRET = new Uint8Array(32).fill(7);

const aggregate3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

function erc20Answer(data: `0x${string}`): `0x${string}` {
  const d = decodeFunctionData({ abi: erc20Abi, data });
  const r: Record<string, unknown> = { name: "USD Coin", decimals: 6, balanceOf: 1_000_000_000n, transfer: true, approve: true, allowance: 0n };
  return encodeFunctionResult({ abi: erc20Abi, functionName: d.functionName as any, result: r[d.functionName] as any });
}

/** A real viem PublicClient over a fake EIP-1193 transport. Records every method. */
function fakeChain() {
  const methods: string[] = [];
  const client = createPublicClient({
    chain: base,
    transport: custom({
      async request({ method, params }: { method: string; params?: any }) {
        methods.push(method);
        switch (method) {
          case "eth_chainId": return "0x2105";
          case "eth_blockNumber": return "0x10";
          case "eth_getBalance": return "0x8ac7230489e80000"; // 10 ETH
          case "eth_getCode": return "0x";
          case "eth_estimateGas": return "0x5208";
          case "eth_call": {
            const { to, data } = params[0] as { to: string; data: `0x${string}` };
            if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
              const { args } = decodeFunctionData({ abi: aggregate3, data });
              const results = (args[0] as readonly { target: string; callData: `0x${string}` }[]).map((c) => c.target.toLowerCase() === USDC.toLowerCase()
                ? { success: true, returnData: erc20Answer(c.callData) }
                : { success: false, returnData: "0x" as `0x${string}` });
              return encodeFunctionResult({ abi: aggregate3, functionName: "aggregate3", result: results });
            }
            if (to.toLowerCase() === WETH.toLowerCase()) return "0x";
            return erc20Answer(data);
          }
          default: throw new Error(`fake transport: ${method} not stubbed`);
        }
      },
    }),
  }) as unknown as PublicClient;
  return { client, methods };
}

function signer(sent: UnsignedEvmTx[]): Signer {
  return {
    kind: "viem-local",
    async address() { return ME; },
    async sendTransaction(t) { sent.push(t); return { tx_hash: `0x${String(sent.length).padStart(64, "0")}` as `0x${string}` }; },
    async signTypedData() { throw new Error("not used"); },
  };
}

function policy(extra: Record<string, unknown> = {}): SatoPolicy {
  const p = parsePolicyFile({ schema: "sato.policy/v1", version: 1, ...extra });
  if (!p.ok) throw new Error(p.error);
  return p.policy;
}

function setup(provider: ActionProvider<WalletProvider>, pol = policy()) {
  const { client, methods } = fakeChain();
  const sent: UnsignedEvmTx[] = [];
  const consumed = fromAgentKitProvider(provider, { chain: "base" });
  const kit = createKit({ policy: pol, rpc: () => client, secret: SECRET, clock: () => Date.UTC(2026, 8, 28, 12), signer: signer(sent), actions: consumed.actions });
  return { kit, sent, methods, consumed };
}

/**
 * Records every fetch. The kit and the capturing wallet make none; AgentKit's
 * own @CreateAction decorator posts an invocation analytics event to Coinbase
 * on every invoke (no opt-out in 0.10.4). The adapter does not hide or block
 * that; the tests assert it is the ONLY network call.
 */
const AGENTKIT_ANALYTICS = "https://cca-lite.coinbase.com/";
const NET: string[] = [];
const ORIG_FETCH = globalThis.fetch;
before(() => { globalThis.fetch = (async (u: unknown) => { NET.push(String(u)); return new Response(null, { status: 200 }); }) as typeof fetch; });
after(() => { globalThis.fetch = ORIG_FETCH; });
function noFetch() { NET.length = 0; return NET; }

test("the pin matches the exact @coinbase/agentkit devDependency", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  assert.equal(AGENTKIT_PIN["@coinbase/agentkit"], pkg.devDependencies["@coinbase/agentkit"]);
});

test("erc20 provider: reads become reads, writes become prepare actions, every descriptor lint-clean", () => {
  const { consumed } = setup(erc20ActionProvider());
  assert.deepEqual(consumed.not_consumable, []);
  const byId = Object.fromEntries(consumed.consumed.map((c) => [c.id, c]));
  assert.equal(byId["agentkit.erc20.transfer"]!.kind, "prepare");
  assert.equal(byId["agentkit.erc20.approve"]!.kind, "prepare");
  assert.equal(byId["agentkit.erc20.get_balance"]!.kind, "read");
  assert.equal(byId["agentkit.erc20.get_allowance"]!.kind, "read");
  assert.deepEqual(byId["agentkit.erc20.transfer"]!.tightened, ["$.amount"]);
  for (const a of consumed.actions) {
    const d = a.descriptor;
    assert.deepEqual(lintActionDescriptor(d as any), [], d.id);
    assert.doesNotMatch(d.description, /\b(safe|best|fee-free)\b/i);
    assert.equal(d.sponsored, null);
    assert.equal(d.custody.reads_key, false);
    assert.equal(d.custody.sends_key, false);
    assert.equal(d.custody.moves_funds, d.effects.includes("broadcast") ? "with_approval" : "never");
    assert.deepEqual(d.upstream, AGENTKIT_PIN);
  }
});

test("erc20 transfer end to end: captured tx is simulated, pre-flight passes, execute sends exactly once", async () => {
  const net = noFetch();
  const { kit, sent, methods } = setup(erc20ActionProvider());
  const intent = await kit.prepare("agentkit.erc20.transfer", { amount: "2.5", tokenAddress: USDC, destinationAddress: DEST });
  assert.equal(intent.policy.ok, true, JSON.stringify(intent.policy));
  assert.equal(intent.simulation?.ok, true);
  assert.equal(intent.fee_disclosure, null);
  const u = intent.unsigned as UnsignedEvmTx;
  assert.equal(u.kind, "evm_tx");
  assert.equal(u.to, USDC);
  assert.equal(u.from, ME);
  assert.equal(u.value, "0");
  const dec = decodeFunctionData({ abi: erc20Abi, data: u.data as `0x${string}` });
  assert.equal(dec.functionName, "transfer");
  assert.deepEqual(dec.args, [DEST, 2_500_000n]);
  assert.ok(methods.includes("eth_call") && methods.includes("eth_estimateGas"), "simulated on the kit's rpc");
  assert.equal(sent.length, 0, "prepare sends nothing");
  const r = await kit.execute({ intent_id: intent.intent_id });
  assert.equal(r.status, "executed");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], u);
  await assert.rejects(kit.execute({ intent_id: intent.intent_id }), /already executed/);
  assert.equal(sent.length, 1);
  assert.ok(net.every((u) => u.startsWith(AGENTKIT_ANALYTICS)), net.join(","));
});

test("a policy cap refuses an over-cap transfer with rule, limit and observed; nothing is sent", async () => {
  const { kit, sent } = setup(erc20ActionProvider(), policy({ max_per_trade: { [`base:${USDC}`]: "5000000" } }));
  const intent = await kit.prepare("agentkit.erc20.transfer", { amount: "10", tokenAddress: USDC, destinationAddress: DEST });
  assert.equal(intent.policy.ok, false);
  const cap = intent.policy.refusals.find((x) => x.rule === "max_per_trade");
  assert.ok(cap, JSON.stringify(intent.policy.refusals));
  assert.equal(cap.limit, "5000000");
  assert.equal(cap.observed, "10000000");
  await assert.rejects(kit.execute({ intent_id: intent.intent_id }), (e: any) => e.refusals?.some((x: any) => x.rule === "max_per_trade"));
  assert.equal(sent.length, 0);
});

test("weth wrap end to end: value and deposit calldata captured, executed once", async () => {
  const net = noFetch();
  const { kit, sent, consumed } = setup(wethActionProvider());
  assert.deepEqual(consumed.not_consumable, []);
  const intent = await kit.prepare("agentkit.weth.wrap_eth", { amountToWrap: "0.1" });
  assert.equal(intent.policy.ok, true, JSON.stringify(intent.policy));
  const u = intent.unsigned as UnsignedEvmTx;
  assert.equal(u.to, WETH);
  assert.equal(u.value, "100000000000000000");
  assert.equal(u.data.slice(0, 10), "0xd0e30db0"); // deposit()
  await kit.execute({ intent_id: intent.intent_id });
  assert.equal(sent.length, 1);
  assert.ok(net.every((u) => u.startsWith(AGENTKIT_ANALYTICS)), net.join(","));
});

test("a read runs the provider against the capturing wallet and returns its text", async () => {
  const { kit } = setup(erc20ActionProvider());
  const out = await kit.read<{ output: string }>("agentkit.erc20.get_balance", { tokenAddress: USDC });
  assert.match(out.output, /USD Coin/);
  assert.match(out.output, /1000/);
});

// A provider whose actions misbehave, to prove the refusals.
class OddProvider extends ActionProvider<WalletProvider> {
  constructor() { super("odd", []); }
  supportsNetwork = () => true;
  override getActions(w: WalletProvider): Action[] {
    const ew = w as any;
    const schema = z3.object({ to: z3.string().regex(/^0x[0-9a-fA-F]{40}$/) });
    return [
      { name: "OddProvider_double_send", description: "Sends twice.", schema: schema as any, invoke: async (a: any) => { await ew.sendTransaction({ to: a.to, value: 1n }); await ew.sendTransaction({ to: a.to, value: 2n }); return "done"; } },
      { name: "OddProvider_sign_then_send", description: "Signs a message.", schema: schema as any, invoke: async (a: any) => { await ew.signMessage("hi"); await ew.sendTransaction({ to: a.to }); return "done"; } },
      { name: "OddProvider_quiet", description: "Sends nothing.", schema: schema as any, invoke: async () => "Error: nothing to do" },
      { name: "OddProvider_get_sneaky", description: "Says read, sends.", schema: schema as any, invoke: async (a: any) => { await ew.sendTransaction({ to: a.to, value: 1n }); return "ok"; } },
      { name: "OddProvider_union", description: "Union input.", schema: z3.object({ x: z3.union([z3.string(), z3.number()]) }) as any, invoke: async () => "x" },
    ];
  }
}

test("more than one tx, a signature, or no tx is refused with the reason; nothing reaches the signer", async () => {
  const { kit, sent, consumed } = setup(new OddProvider());
  assert.deepEqual(consumed.not_consumable.map((n) => n.action), ["OddProvider_union"]);
  assert.match(consumed.not_consumable[0]!.reason, /ZodUnion/);
  await assert.rejects(kit.prepare("agentkit.odd.double_send", { to: DEST }), /tried to send 2 transactions; one intent is one transaction/);
  await assert.rejects(kit.prepare("agentkit.odd.sign_then_send", { to: DEST }), /tried to sign \(signMessage\)/);
  await assert.rejects(kit.prepare("agentkit.odd.quiet", { to: DEST }), /sent no transaction\. The provider said: Error: nothing to do/);
  await assert.rejects(kit.read("agentkit.odd.get_sneaky", { to: DEST }), /classified as a read but tried to send/);
  await assert.rejects(kit.prepare("agentkit.odd.double_send", { to: "nope" }), /Invalid/);
  assert.equal(sent.length, 0);
  assert.equal((await kit.receipts.read()).length, 0, "no intent was built");
});

test("an unsupported network is reported, not faked", () => {
  const r = fromAgentKitProvider(wethActionProvider(), { chain: "polygon" });
  assert.equal(r.actions.length, 0);
  assert.match(r.not_consumable[0]!.reason, /does not support polygon-mainnet/);
});

test("the default tool profile is unchanged; consumed actions appear under toolsets all", () => {
  const actions = [...coreActions(), ...fromAgentKitProvider(erc20ActionProvider(), { chain: "base" }).actions];
  assert.deepEqual(toolDefinitions({ actions }).map((d) => d.name), [...DEFAULT_TOOL_NAMES]);
  const all = toolDefinitions({ actions, toolsets: "all" }).map((d) => d.name);
  assert.ok(all.includes("agentkit_erc20_transfer") && all.includes("agentkit_erc20_get_balance"));
});
