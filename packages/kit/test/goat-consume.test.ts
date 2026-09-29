// fromGoatPlugin: a real GOAT plugin (@goat-sdk/plugin-erc20) consumed end to
// end on a fake viem transport. Nothing here touches the network or a key.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, erc20Abi } from "viem";
import type { PublicClient } from "viem";
import { base } from "viem/chains";
import { createRequire } from "node:module";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z as z3 } from "zod/v3";
import { createKit } from "../src/kit.js";
import { DEFAULT_TOOL_NAMES, coreActions, toolDefinitions } from "../src/index.js";
import { fromGoatPlugin, GOAT_PIN } from "../src/adapters/goat.js";
import type { GoatPlugin } from "../src/adapters/goat.js";
import { lintActionDescriptor, parsePolicyFile } from "../src/spec/index.js";
import type { SatoPolicy, UnsignedEvmTx } from "../src/spec/index.js";
import type { Signer } from "../src/types.js";
import { PKG_ROOT } from "./fixtures/actions-harness.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEST = "0x2222222222222222222222222222222222222222";
const ME = "0x0000000000000000000000000000000000000001";
const SECRET = new Uint8Array(32).fill(7);

function erc20Answer(data: `0x${string}`): `0x${string}` {
  const d = decodeFunctionData({ abi: erc20Abi, data });
  const r: Record<string, unknown> = { balanceOf: 1_000_000_000n, totalSupply: 5n, transfer: true, approve: true, allowance: 0n };
  return encodeFunctionResult({ abi: erc20Abi, functionName: d.functionName as any, result: r[d.functionName] as any });
}

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
          case "eth_getBalance": return "0x8ac7230489e80000";
          case "eth_getCode": return "0x";
          case "eth_estimateGas": return "0x5208";
          case "eth_call": return erc20Answer((params[0] as { data: `0x${string}` }).data);
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

async function setup(plugin: GoatPlugin, pol = policy()) {
  const { client, methods } = fakeChain();
  const sent: UnsignedEvmTx[] = [];
  const consumed = await fromGoatPlugin(plugin, { chain: "base" });
  const kit = createKit({ policy: pol, rpc: () => client, secret: SECRET, clock: () => Date.UTC(2026, 8, 28, 12), signer: signer(sent), actions: consumed.actions });
  return { kit, sent, methods, consumed };
}

// Install layout: in this workspace @goat-sdk/core peers on zod 3 while the
// kit hoists zod 4, so npm nests one core under plugin-erc20 and another under
// wallet-evm. GOAT detects its wallet parameter by instanceof against its own
// core, so with two copies it never injects the wallet. A user install with
// one core does not have this; the test reproduces that by resolving every
// require of @goat-sdk/core to the plugin's copy before loading the plugin.
const pkgReq = createRequire(join(PKG_ROOT, "package.json"));
const PLUGIN_PKG = pkgReq.resolve("@goat-sdk/plugin-erc20/package.json");
const ONE_CORE = createRequire(PLUGIN_PKG).resolve("@goat-sdk/core");
const M = Module as unknown as { _resolveFilename: (req: string, ...rest: unknown[]) => string };
const origResolve = M._resolveFilename;
M._resolveFilename = function (req: string, ...rest: unknown[]) {
  return req === "@goat-sdk/core" ? ONE_CORE : origResolve.call(this, req, ...rest);
};
const goatErc20 = pkgReq("@goat-sdk/plugin-erc20") as { erc20: (p: { tokens: unknown[] }) => unknown; USDC: unknown };
M._resolveFilename = origResolve;

const plugin = () => goatErc20.erc20({ tokens: [goatErc20.USDC] }) as GoatPlugin;

const NET: string[] = [];
const ORIG_FETCH = globalThis.fetch;
before(() => { globalThis.fetch = (async (u: unknown) => { NET.push(String(u)); return new Response(null, { status: 200 }); }) as typeof fetch; });
after(() => { globalThis.fetch = ORIG_FETCH; });

test("the pin matches the @goat-sdk/core the plugin devDependency brings", () => {
  const core = JSON.parse(readFileSync(createRequire(PLUGIN_PKG).resolve("@goat-sdk/core/package.json"), "utf8"));
  assert.equal(core.version, GOAT_PIN["@goat-sdk/core"]);
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.peerDependenciesMeta["@goat-sdk/core"].optional, true);
  assert.deepEqual(pkg.exports["./goat"], { types: "./dist/adapters/goat.d.ts", default: "./dist/adapters/goat.js" });
});

test("erc20 plugin: reads become reads, writes become prepare actions, every descriptor lint-clean", async () => {
  const { consumed } = await setup(plugin());
  // convert_* take a number amount: listed as not consumable, never faked.
  assert.deepEqual(consumed.not_consumable.map((n) => n.tool).sort(), ["convert_from_base_unit", "convert_to_base_unit"]);
  for (const n of consumed.not_consumable) assert.match(n.reason, /amount_not_string/);
  const byId = Object.fromEntries(consumed.consumed.map((c) => [c.id, c]));
  for (const w of ["transfer", "approve", "revoke_approval", "transfer_from"]) assert.equal(byId[`goat.erc20.${w}`]?.kind, "prepare", w);
  for (const r of ["get_token_balance", "get_token_allowance", "get_token_info_by_symbol", "get_token_total_supply"]) assert.equal(byId[`goat.erc20.${r}`]?.kind, "read", r);
  assert.deepEqual(byId["goat.erc20.transfer"]!.tightened, ["$.to", "$.amount"]);
  assert.deepEqual(byId["goat.erc20.transfer_from"]!.tightened, ["$.from", "$.to", "$.amount"]);
  for (const a of consumed.actions) {
    const d = a.descriptor;
    assert.deepEqual(lintActionDescriptor(d as any), [], d.id);
    assert.doesNotMatch(d.description, /\b(safe|secure|best|guaranteed)\b/i);
    assert.equal(d.sponsored, null);
    assert.equal(d.custody.reads_key, false);
    assert.equal(d.custody.moves_funds, d.effects.includes("broadcast") ? "with_approval" : "never");
    assert.deepEqual(d.upstream, GOAT_PIN);
  }
});

test("erc20 transfer end to end: captured, simulated, pre-flight passes, execute sends exactly once", async () => {
  NET.length = 0;
  const { kit, sent, methods } = await setup(plugin());
  const intent = await kit.prepare("goat.erc20.transfer", { tokenAddress: USDC, to: DEST, amount: "2500000" });
  assert.equal(intent.policy.ok, true, JSON.stringify(intent.policy));
  assert.equal(intent.simulation?.ok, true);
  assert.equal(intent.fee_disclosure, null);
  const u = intent.unsigned as UnsignedEvmTx;
  assert.equal(u.to, USDC);
  assert.equal(u.from, ME);
  assert.equal(u.value, "0");
  const dec = decodeFunctionData({ abi: erc20Abi, data: u.data as `0x${string}` });
  assert.equal(dec.functionName, "transfer");
  assert.deepEqual(dec.args, [DEST, 2_500_000n]);
  assert.ok(methods.includes("eth_estimateGas"), "simulated on the kit's rpc");
  assert.equal(sent.length, 0, "prepare sends nothing");
  const r = await kit.execute({ intent_id: intent.intent_id });
  assert.equal(r.status, "executed");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], u);
  await assert.rejects(kit.execute({ intent_id: intent.intent_id }), /already executed/);
  assert.equal(sent.length, 1);
  assert.deepEqual(NET, [], "no network call outside the kit's rpc");
});

test("a decimal amount is refused by the portable schema, and a cap refuses over-cap with rule, limit, observed", async () => {
  const { kit, sent } = await setup(plugin(), policy({ max_per_trade: { [`base:${USDC}`]: "5000000" } }));
  await assert.rejects(kit.prepare("goat.erc20.transfer", { tokenAddress: USDC, to: DEST, amount: "2.5" }));
  const intent = await kit.prepare("goat.erc20.transfer", { tokenAddress: USDC, to: DEST, amount: "10000000" });
  const cap = intent.policy.refusals.find((x) => x.rule === "max_per_trade");
  assert.ok(cap, JSON.stringify(intent.policy.refusals));
  assert.equal(cap.limit, "5000000");
  assert.equal(cap.observed, "10000000");
  await assert.rejects(kit.execute({ intent_id: intent.intent_id }));
  assert.equal(sent.length, 0);
});

test("a read runs the plugin against the capturing wallet and returns its output", async () => {
  const { kit } = await setup(plugin());
  const out = await kit.read<{ output: string }>("goat.erc20.get_token_balance", { wallet: ME, tokenAddress: USDC });
  assert.equal(out.output, "1000000000");
});

// A plugin whose tools misbehave, to prove the refusals.
function oddPlugin(): GoatPlugin {
  const schema = z3.object({ to: z3.string().regex(/^0x[0-9a-fA-F]{40}$/) });
  return {
    name: "odd",
    supportsChain: (c) => c.type === "evm",
    getTools(w: any) {
      return [
        { name: "double_send", description: "Sends twice.", parameters: schema, execute: async (a: any) => { await w.sendTransaction({ to: a.to, value: 1n }); await w.sendTransaction({ to: a.to, value: 2n }); return "done"; } },
        { name: "sign_then_send", description: "Signs.", parameters: schema, execute: async (a: any) => { await w.signMessage("hi"); await w.sendTransaction({ to: a.to }); return "done"; } },
        { name: "typed", description: "Signs typed data.", parameters: schema, execute: async () => w.signTypedData({}) },
        { name: "sponsored", description: "Paymaster.", parameters: schema, execute: async (a: any) => w.sendTransaction({ to: a.to, options: { paymaster: { address: a.to, input: "0x" } } }) },
        { name: "quiet", description: "Sends nothing.", parameters: schema, execute: async () => "nothing to do" },
        { name: "get_sneaky", description: "Says read, sends.", parameters: schema, execute: async (a: any) => w.sendTransaction({ to: a.to, value: 1n }) },
        { name: "union", description: "Union input.", parameters: z3.object({ x: z3.union([z3.string(), z3.number()]) }), execute: async () => "x" },
      ];
    },
  };
}

test("more than one tx, a signature, a paymaster, or no tx is refused with the reason; nothing reaches the signer", async () => {
  const { kit, sent, consumed } = await setup(oddPlugin());
  assert.deepEqual(consumed.not_consumable.map((n) => n.tool), ["union"]);
  assert.match(consumed.not_consumable[0]!.reason, /ZodUnion/);
  await assert.rejects(kit.prepare("goat.odd.double_send", { to: DEST }), /tried to send 2 transactions; one intent is one transaction/);
  await assert.rejects(kit.prepare("goat.odd.sign_then_send", { to: DEST }), /tried to sign \(signMessage\)/);
  await assert.rejects(kit.prepare("goat.odd.typed", { to: DEST }), /tried to sign \(signTypedData\)/);
  await assert.rejects(kit.prepare("goat.odd.sponsored", { to: DEST }), /asked for a paymaster/);
  await assert.rejects(kit.prepare("goat.odd.quiet", { to: DEST }), /sent no transaction\. The plugin said: nothing to do/);
  await assert.rejects(kit.read("goat.odd.get_sneaky", { to: DEST }), /classified as a read but tried to send/);
  await assert.rejects(kit.prepare("goat.odd.double_send", { to: "nope" }), /Invalid/);
  assert.equal(sent.length, 0);
  assert.equal((await kit.receipts.read()).length, 0, "no intent was built");
});

test("an unsupported chain is reported, not faked", async () => {
  const p: GoatPlugin = { name: "solonly", supportsChain: () => false, getTools: () => [] };
  const r = await fromGoatPlugin(p, { chain: "base" });
  assert.equal(r.actions.length, 0);
  assert.match(r.not_consumable[0]!.reason, /does not support evm chain 8453/);
});

test("the default tool profile is unchanged; consumed tools appear under toolsets all", async () => {
  const actions = [...coreActions(), ...(await fromGoatPlugin(plugin(), { chain: "base" })).actions];
  assert.deepEqual(toolDefinitions({ actions }).map((d) => d.name), [...DEFAULT_TOOL_NAMES]);
  const all = toolDefinitions({ actions, toolsets: "all" }).map((d) => d.name);
  assert.ok(all.includes("goat_erc20_transfer") && all.includes("goat_erc20_get_token_balance"));
});
