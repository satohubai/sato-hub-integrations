// SIGNER builder. Open Wallet Standard signer.
/**
 * STRUCTURAL adapter over an OWS wallet. This file does NOT import
 * `@open-wallet-standard/core`: that package embeds a Rust core as a native
 * addon with prebuilt binaries for darwin/linux only, and the kit keeps zero
 * runtime dependencies. You pass in a viem-compatible account backed by OWS,
 * e.g. `owsToViemAccount("agent-wallet")` from `@open-wallet-standard/adapters/viem`.
 * See OWS.md for the research behind this.
 *
 * Enforcement lives in OWS: its pre-signing policy engine gates API-key
 * operations before the key is decrypted, inside the OWS signing path. The
 * kit's policy is only a pre-flight that explains refusals. Attach a compiled
 * OWS policy document with `nativePolicy` so it travels with the signer.
 */
import { createWalletClient, custom, defineChain } from "viem";
import type { OdaChain, UnsignedEvmTx } from "../spec/index.js";
import type { RpcProvider, Signer, TypedDataInput } from "../types.js";
import { assertFromMatches, assertUnsignedEvmTx } from "./shared.js";

/** The subset of a viem LocalAccount an OWS-backed account provides. */
export type OwsViemAccount = {
  address: `0x${string}`;
  type: "local";
  signTransaction: (...args: any[]) => Promise<`0x${string}`>;
  signTypedData: (td: any) => Promise<`0x${string}`>;
  signMessage: (...args: any[]) => Promise<`0x${string}`>;
};

export type OwsSignerOptions = {
  /** An OWS-backed viem account (see the doc comment). */
  wallet: unknown;
  /** Needed for sendTransaction; signTypedData works without it. */
  rpc?: RpcProvider;
  /** A compiled OWS policy document to carry with the signer. */
  nativePolicy?: unknown;
};

function asAccount(w: unknown): OwsViemAccount {
  const a = w as OwsViemAccount;
  if (!a || typeof a !== "object" || typeof a.address !== "string" || typeof a.signTransaction !== "function" ||
    typeof a.signTypedData !== "function") {
    throw new Error("owsSigner: `wallet` must be an OWS-backed viem account (address, signTransaction, signTypedData)");
  }
  return a;
}

export function owsSigner(opts: OwsSignerOptions): Signer {
  const account = asAccount(opts?.wallet);
  const signer: Signer = {
    kind: "ows",
    async address(_chain: OdaChain) {
      return account.address;
    },
    async sendTransaction(tx: UnsignedEvmTx) {
      assertUnsignedEvmTx(tx);
      assertFromMatches(tx, account.address);
      if (!opts.rpc) throw new Error("owsSigner: `rpc` is required to send a transaction");
      const client = opts.rpc(tx.chain as OdaChain);
      const chain = defineChain({
        id: tx.chain_id,
        name: tx.chain,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [] } },
      });
      const wallet = createWalletClient({
        account: account as any,
        chain,
        transport: custom({ request: (args: any) => client.request(args) }),
      });
      const hash = await wallet.sendTransaction({
        account: account as any,
        chain,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        value: BigInt(tx.value),
      });
      return { tx_hash: hash };
    },
    async signTypedData(td: TypedDataInput) {
      return account.signTypedData(td);
    },
  };
  if (opts.nativePolicy !== undefined) signer.nativePolicy = { format: "ows", document: opts.nativePolicy };
  return signer;
}
