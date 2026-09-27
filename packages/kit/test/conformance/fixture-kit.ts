// Offline kit for the conformance suite: the real core actions, pre-flight,
// simulateTx and viemLocalSigner over a fake base fork (chain id 31337), a fake
// fetch serving the recorded swap fixtures, and a fixed clock. The key is
// generated in memory and never funded; nothing touches the network.
import { createPublicClient, custom, keccak256, type PublicClient } from "viem";
import { CORE_ACTIONS, createKit, parsePolicyFile, viemLocalSigner } from "../../src/index.js";
import type { SatoPolicy } from "../../src/spec/index.js";
import type { Kit, RpcProvider } from "../../src/types.js";
import { FIXED_NOW, fakeFetch, fixture } from "../fixtures/actions-harness.js";

const SATO_TX = fixture("sato-swap-build-tx.base.json");
const LIFI = fixture("lifi-quote.base.json");
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH = "0x4200000000000000000000000000000000000006";
const MAX_UINT = "0x" + "f".repeat(64);
export const FORK_BLOCK = 16;

export function fakeFork() {
  const sent: string[] = [];
  const request = async ({ method, params }: { method: string; params?: any[] }) => {
    switch (method) {
      case "eth_chainId": return "0x7a69";
      case "eth_blockNumber": return "0x" + FORK_BLOCK.toString(16);
      case "eth_call": return MAX_UINT;
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
  return { rpc, sent };
}

export function testPolicy(extra: Record<string, unknown> = {}): SatoPolicy {
  const p = parsePolicyFile({ schema: "sato.policy/v1", version: 1, network: "fork", allow_chains: ["base"], ...extra });
  if (!p.ok) throw new Error(p.error);
  return p.policy;
}

export type FixtureKit = { kit: Kit; policy: SatoPolicy; sent: string[]; taker: string; swapInput: Record<string, unknown> };

export async function fixtureKit(extraPolicy: Record<string, unknown> = {}): Promise<FixtureKit> {
  const policy = testPolicy(extraPolicy);
  const f = fakeFork();
  const signer = viemLocalSigner({ generate: true, rpc: f.rpc, fork: true });
  const taker = await signer.address("base");
  const http = fakeFetch([
    { match: (u) => u.startsWith("https://satohub.ai/"), body: SATO_TX },
    { match: (u) => u.startsWith("https://li.quest/"), body: LIFI },
  ]);
  const kit = createKit({
    actions: CORE_ACTIONS.list(),
    policy,
    signer,
    rpc: f.rpc,
    fetch: http.fetch,
    clock: () => FIXED_NOW,
    secret: new Uint8Array(32).fill(5),
  });
  const swapInput = { chain: "base", sell_token: USDC, buy_token: WETH, sell_amount: "10000000", slippage_bps: 50, taker };
  return { kit, policy, sent: f.sent, taker, swapInput };
}
