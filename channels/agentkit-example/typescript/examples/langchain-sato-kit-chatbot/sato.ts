import { AgentKit, walletActionProvider } from "@coinbase/agentkit";
import type { EvmWalletProvider } from "@coinbase/agentkit";
import { coreActions, createKit, humanApprove, parsePolicyFile } from "@satohub/kit";
import type { OdaChain, Signer, UnsignedEvmTx } from "@satohub/kit";
import { satoKitActionProvider } from "@satohub/kit/agentkit";
import type { SatoKitApprove } from "@satohub/kit/agentkit";
import { createPublicClient, http } from "viem";
import type { PublicClient } from "viem";

/**
 * A Sato Kit signer over an AgentKit EVM wallet provider (CDP, Privy, viem, ...).
 * The wallet provider holds the key and applies its own policies; the kit's
 * policy is a pre-flight that explains refusals before the wallet is asked.
 *
 * @param walletProvider - the AgentKit wallet provider that signs
 * @returns a Sato Kit Signer
 */
export function walletProviderSigner(walletProvider: EvmWalletProvider): Signer {
  return {
    kind: "cdp",
    async address(_chain: OdaChain) {
      return walletProvider.getAddress() as `0x${string}`;
    },
    async sendTransaction(tx: UnsignedEvmTx) {
      const chainId = Number(walletProvider.getNetwork().chainId);
      if (chainId !== tx.chain_id) {
        throw new Error(`intent is for chain id ${tx.chain_id}; the wallet is on ${chainId}`);
      }
      const hash = await walletProvider.sendTransaction({
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: BigInt(tx.value),
      });
      return { tx_hash: hash };
    },
    async signTypedData(td) {
      return walletProvider.signTypedData(td);
    },
  };
}

export type SatoAgentKitOptions = {
  walletProvider: EvmWalletProvider;
  /** Parsed policy.json (sato.policy/v1). */
  policy: unknown;
  /** RPC the kit simulates against, per chain. */
  rpcUrl: (chain: OdaChain) => string | undefined;
  /** Asked before every prepare that would sign, pay or broadcast, and before execute. */
  approve: SatoKitApprove;
};

/**
 * AgentKit with the wallet actions and the Sato Kit tools (read, prepare,
 * execute). Every signature goes through `approve` twice over: the Sato Kit
 * AgentKit provider asks before execute, and the signer is wrapped in
 * humanApprove.
 *
 * @param opts - wallet provider, policy, RPC and approval callback
 * @returns an AgentKit instance
 */
export async function createAgentKitWithSato(opts: SatoAgentKitOptions): Promise<AgentKit> {
  const parsed = parsePolicyFile(opts.policy ?? {});
  if (!parsed.ok) throw new Error(`policy.json: ${parsed.error}`);
  const clients = new Map<string, PublicClient>();
  const kit = createKit({
    policy: parsed.policy,
    actions: coreActions(),
    rpc: chain => {
      const url = opts.rpcUrl(chain);
      if (!url) throw new Error(`no RPC URL for ${chain}`);
      let c = clients.get(url);
      if (!c) {
        c = createPublicClient({ transport: http(url) }) as PublicClient;
        clients.set(url, c);
      }
      return c;
    },
    signer: humanApprove(walletProviderSigner(opts.walletProvider), async s =>
      opts.approve(`Sign ${s.kind} with the wallet provider?\n${JSON.stringify(s, null, 2)}`, {
        tool: "signer",
        args: s,
      }),
    ),
    userAgent: "agentkit-example-sato-kit/0.1.0",
  });
  return AgentKit.from({
    walletProvider: opts.walletProvider,
    actionProviders: [walletActionProvider(), satoKitActionProvider(kit, { approve: opts.approve })],
  });
}
