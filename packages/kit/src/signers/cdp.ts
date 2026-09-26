// SIGNER builder. Coinbase CDP server wallet (optional peer @coinbase/cdp-sdk).
/**
 * STRUCTURAL adapter over a CDP EVM server account (`cdp.evm.createAccount()` /
 * `getOrCreateAccount()` in `@coinbase/cdp-sdk`). This file does not import the
 * SDK; it calls only the members declared in `CdpEvmAccountLike`.
 *
 * Enforcement happens in CDP: the key lives in CDP's enclave and CDP applies
 * its account/project policies before it signs. The kit's policy is a
 * pre-flight that explains refusals. Pass a compiled CDP policy (from
 * `compileCdpPolicy`) as `nativePolicy` so it is attached to this signer; the
 * adapter carries it, it does not register it with CDP.
 */
import type { OdaChain, UnsignedEvmTx } from "../spec/index.js";
import type { Signer, TypedDataInput } from "../types.js";
import { assertFromMatches, assertUnsignedEvmTx } from "./shared.js";

/** The members of a CDP EvmServerAccount this adapter calls. */
export interface CdpEvmAccountLike {
  address: `0x${string}`;
  sendTransaction(args: {
    network: string;
    transaction: { to: `0x${string}`; data?: `0x${string}`; value?: bigint };
  }): Promise<{ transactionHash: `0x${string}` }>;
  signTypedData(args: {
    domain: Record<string, unknown>;
    types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

export type CdpSignerOptions = {
  account: unknown;
  /** A compiled CDP policy document (see compileCdpPolicy). Carried, not registered. */
  nativePolicy?: unknown;
};

/** ODA chain -> CDP network name. Chains CDP does not name here are refused. */
export const CDP_NETWORKS: Partial<Record<OdaChain, string>> = {
  ethereum: "ethereum",
  sepolia: "ethereum-sepolia",
  base: "base",
  "base-sepolia": "base-sepolia",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
};

function asAccount(a: unknown): CdpEvmAccountLike {
  const x = a as CdpEvmAccountLike;
  if (!x || typeof x !== "object" || typeof x.address !== "string" || typeof x.sendTransaction !== "function" ||
    typeof x.signTypedData !== "function") {
    throw new Error("cdpSigner: `account` must be a CDP EVM account (address, sendTransaction, signTypedData)");
  }
  return x;
}

export function cdpSigner(opts: CdpSignerOptions): Signer {
  const account = asAccount(opts?.account);
  const signer: Signer = {
    kind: "cdp",
    async address(_chain: OdaChain) {
      return account.address;
    },
    async sendTransaction(tx: UnsignedEvmTx) {
      assertUnsignedEvmTx(tx);
      assertFromMatches(tx, account.address);
      const network = CDP_NETWORKS[tx.chain as OdaChain];
      if (!network) throw new Error(`cdpSigner: chain ${tx.chain} has no CDP network mapping`);
      const r = await account.sendTransaction({
        network,
        transaction: { to: tx.to as `0x${string}`, data: tx.data as `0x${string}`, value: BigInt(tx.value) },
      });
      return { tx_hash: r.transactionHash };
    },
    async signTypedData(td: TypedDataInput) {
      return account.signTypedData(td);
    },
  };
  if (opts.nativePolicy !== undefined) signer.nativePolicy = { format: "cdp", document: opts.nativePolicy };
  return signer;
}
