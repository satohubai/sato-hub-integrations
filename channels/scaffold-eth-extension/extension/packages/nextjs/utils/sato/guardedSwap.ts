// Sato Kit, server side. Builds a kit that can QUOTE and PREPARE swaps and
// nothing else: it holds no key and has no signer, so it cannot move funds.
// The browser wallet signs the unsigned transaction after the person has read
// the summary, the simulation and the pre-flight result.
//
// The pre-flight explains refusals before the wallet is asked; the wallet's
// own confirmation is the signature.
import type { GuardedSwapInput, GuardedSwapResult } from "./walletTx";
import { createKit, parsePolicyFile, swapPrepareAction, swapQuoteAction } from "@satohub/kit";
import type { Kit, OdaChain, Refusal, SatoPolicy } from "@satohub/kit";
import { createPublicClient, http } from "viem";
import type { PublicClient } from "viem";

export type { GuardedSwapInput, GuardedSwapResult, WalletTx } from "./walletTx";
export { walletTxFor } from "./walletTx";

/** Where the kit simulates when the policy network is "fork": a local node forked from the chain. */
export const LOCAL_FORK_RPC = "http://127.0.0.1:8545";

export type BuildOptions = {
  /** The parsed contents of policy.json. Missing fields take the kit defaults (network "fork"). */
  policy: unknown;
  /** chain -> RPC URL. On the fork network every chain defaults to LOCAL_FORK_RPC. */
  rpcUrl?: (chain: OdaChain) => string | undefined;
  fetch?: typeof fetch;
  clock?: () => number;
  makeClient?: (url: string) => PublicClient;
};

export function loadPolicy(json: unknown): SatoPolicy {
  const parsed = parsePolicyFile(json ?? {});
  if (!parsed.ok) throw new Error(`policy.json: ${parsed.error}`);
  return parsed.policy;
}

export function buildGuardedSwapKit(opts: BuildOptions): Kit {
  const policy = loadPolicy(opts.policy);
  const makeClient = opts.makeClient ?? ((url: string) => createPublicClient({ transport: http(url) }) as PublicClient);
  const clients = new Map<string, PublicClient>();
  return createKit({
    policy,
    actions: [swapQuoteAction(), swapPrepareAction()],
    rpc: chain => {
      const url = opts.rpcUrl?.(chain) ?? (policy.network === "fork" ? LOCAL_FORK_RPC : undefined);
      if (!url) throw new Error(`no RPC URL for ${chain}; set SATO_RPC_URL_${chain.toUpperCase().replace(/-/g, "_")}`);
      let c = clients.get(url);
      if (!c) {
        c = makeClient(url);
        clients.set(url, c);
      }
      return c;
    },
    fetch: opts.fetch,
    clock: opts.clock,
    userAgent: "sato-scaffold-eth-extension/0.1.0",
  });
}

/** Prepare one swap intent. A refusal is a normal result that names each rule. */
export async function prepareGuardedSwap(kit: Kit, input: GuardedSwapInput): Promise<GuardedSwapResult> {
  try {
    const intent = await kit.prepare("swap.prepare", { slippage_bps: 50, venue: "direct", ...input });
    return { ok: true, intent };
  } catch (e) {
    const refusals = (e as { refusals?: Refusal[] }).refusals;
    return { ok: false, error: e instanceof Error ? e.message : String(e), ...(refusals ? { refusals } : {}) };
  }
}
