// SIGNER builder. Local viem account; fork/testnet by default.
/**
 * `viemLocalSigner` holds a private key in this process and signs with viem.
 * It is the fork-mode default (see OWS.md for why OWS is not the default here).
 *
 * - Refuses mainnet chain ids (1, 10, 137, 8453, 42161) unless constructed with
 *   `allowMainnet: true`. That option is NOT recommended: a raw key in process
 *   memory has no enforcement boundary. For real funds use a signer whose policy
 *   is enforced outside the agent process (OWS, CDP, Privy, Turnkey, Safe).
 * - `generate: true` makes a throwaway key held only in memory. It is never
 *   written anywhere and is lost when the process exits.
 * - Also refuses when the RPC's own chain id differs from the tx's chain id,
 *   so a fork of mainnet must run with a non-mainnet id (e.g. `anvil --chain-id 31337`).
 *
 * The kit's policy is a pre-flight that explains refusals; this signer does not
 * enforce policy beyond the mainnet refusal above.
 */
import { createWalletClient, custom, defineChain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { OdaChain, UnsignedEvmTx } from "../spec/index.js";
import type { RpcProvider, Signer, TypedDataInput } from "../types.js";
import { assertFromMatches, assertUnsignedEvmTx, isMainnetChainId } from "./shared.js";

export type ViemLocalSignerOptions = (
  | { privateKey: `0x${string}`; generate?: false; rpc: RpcProvider }
  | { generate: true; privateKey?: undefined; rpc: RpcProvider }
) & {
  /** Not recommended. Lets this in-process key sign on mainnet chain ids. */
  allowMainnet?: boolean;
  /**
   * The RPC is a local fork (anvil/hardhat) running with chain id 31337. A tx
   * built for the forked chain (e.g. base, 8453) is then signed with chain id
   * 31337, so the signature is only valid on the fork and cannot be replayed on
   * the real chain. Any other RPC chain id still has to match the tx exactly.
   */
  fork?: boolean;
};

/** The chain id a local fork must report when `fork: true`. */
export const FORK_CHAIN_ID = 31337;

export function viemLocalSigner(opts: ViemLocalSignerOptions): Signer {
  if (!opts || typeof opts.rpc !== "function") throw new Error("viemLocalSigner: `rpc` is required");
  let key: `0x${string}`;
  if (opts.generate === true) {
    if (opts.privateKey !== undefined) throw new Error("viemLocalSigner: pass either privateKey or generate:true, not both");
    key = generatePrivateKey();
  } else {
    if (typeof opts.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(opts.privateKey)) {
      throw new Error("viemLocalSigner: privateKey must be 0x + 64 hex chars, or pass generate:true");
    }
    key = opts.privateKey;
  }
  const account = privateKeyToAccount(key);
  const allowMainnet = opts.allowMainnet === true;
  const rpc = opts.rpc;

  function guardChain(id: number): void {
    if (isMainnetChainId(id) && !allowMainnet) {
      throw new Error(
        `viemLocalSigner: refusing chain id ${id} (a mainnet). This signer is for fork/testnet; ` +
          "use a signer with enforced policy for mainnet.",
      );
    }
  }

  return {
    kind: "viem-local",
    async address(_chain: OdaChain) {
      return account.address;
    },
    async sendTransaction(tx: UnsignedEvmTx) {
      assertUnsignedEvmTx(tx);
      assertFromMatches(tx, account.address);
      const client = rpc(tx.chain as OdaChain);
      if (!client) throw new Error(`viemLocalSigner: no RPC for chain ${tx.chain}`);
      const rpcChainId = Number(await client.request({ method: "eth_chainId" }));
      const onFork = opts.fork === true && rpcChainId === FORK_CHAIN_ID;
      if (!onFork) guardChain(tx.chain_id);
      if (rpcChainId !== tx.chain_id && !onFork) {
        throw new Error(`viemLocalSigner: RPC chain id ${rpcChainId} does not match tx chain_id ${tx.chain_id}`);
      }
      guardChain(rpcChainId);
      const chain = defineChain({
        id: rpcChainId,
        name: tx.chain,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [] } },
      });
      const wallet = createWalletClient({
        account,
        chain,
        transport: custom({ request: (args: any) => client.request(args) }),
      });
      const hash = await wallet.sendTransaction({
        account,
        chain,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: BigInt(tx.value),
      });
      return { tx_hash: hash };
    },
    async signTypedData(td: TypedDataInput) {
      const cid = (td.domain as { chainId?: unknown }).chainId;
      if (cid !== undefined && cid !== null) guardChain(Number(cid));
      return account.signTypedData(td as any);
    },
  };
}
