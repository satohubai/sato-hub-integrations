// SIGNER builder. Devnet-only local Solana signer (Phase 2 wave 2).
/**
 * `solanaLocalSigner` holds an Ed25519 key in this process and signs
 * serialized Solana transactions with `@solana/kit` (an OPTIONAL peer
 * dependency, loaded on first use). It exists for devnet and tests.
 *
 * - Refuses any payload whose chain is not "solana-devnet".
 * - Before sending, asks the RPC for its genesis hash and refuses the
 *   mainnet-beta genesis, so a devnet-labelled payload pointed at a mainnet
 *   RPC is still refused. There is no allowMainnet switch: for real funds use a
 *   signer whose policy is enforced outside the agent process.
 * - `generate: true` makes a throwaway key held only in memory.
 * - Its EVM methods throw: it signs Solana transactions only.
 *
 * The kit's policy is a pre-flight that explains refusals; this signer does
 * not enforce policy beyond the devnet-only rule above.
 */
import type { OdaChain, UnsignedSolanaTx } from "../spec/index.js";
import type { SignedSolanaTx, Signer, SolanaRpcProvider } from "../types.js";
import { SOLANA_MAINNET_GENESIS_HASH, sendSignedSolanaTx } from "../solana/index.js";

export type SolanaLocalSignerOptions = (
  | { secretKey: Uint8Array; generate?: false }
  | { generate: true; secretKey?: undefined }
) & {
  /** Where sendSolanaTransaction sends. Without it the signer can only sign. */
  rpc?: SolanaRpcProvider;
};

type SolanaKitModule = typeof import("@solana/kit");
type KeyPairSigner = Awaited<ReturnType<SolanaKitModule["generateKeyPairSigner"]>>;

async function loadSolanaKit(): Promise<SolanaKitModule> {
  try {
    return await import("@solana/kit");
  } catch {
    throw new Error("solanaLocalSigner needs the optional peer dependency @solana/kit (npm i @solana/kit)");
  }
}

/** A devnet-only Solana signer. `address` resolves to the base58 public key. */
export type SolanaLocalSigner = Signer & {
  kind: "solana-local";
  /** The base58 public key (fee payer). */
  publicKey(): Promise<string>;
  signSolanaTransaction(tx: UnsignedSolanaTx): Promise<SignedSolanaTx>;
  sendSolanaTransaction(tx: UnsignedSolanaTx): Promise<{ signature: string }>;
};

function guardDevnet(tx: UnsignedSolanaTx): void {
  if (!tx || tx.kind !== "solana_tx") throw new Error("solanaLocalSigner: expected an unsigned solana_tx");
  if (tx.chain !== "solana-devnet") {
    throw new Error(`solanaLocalSigner: refusing chain "${tx.chain}". This signer is devnet-only; use a signer with enforced policy for mainnet.`);
  }
}

export function solanaLocalSigner(opts: SolanaLocalSignerOptions): SolanaLocalSigner {
  if (!opts) throw new Error("solanaLocalSigner: options are required");
  if (opts.generate === true && opts.secretKey !== undefined) throw new Error("solanaLocalSigner: pass either secretKey or generate:true, not both");
  if (opts.generate !== true && !(opts.secretKey instanceof Uint8Array && opts.secretKey.length === 64)) {
    throw new Error("solanaLocalSigner: secretKey must be the 64-byte Solana keypair (secret || public), or pass generate:true");
  }
  const secret = opts.generate === true ? null : new Uint8Array(opts.secretKey);
  let signerP: Promise<KeyPairSigner> | null = null;
  const keyPair = (): Promise<KeyPairSigner> =>
    (signerP ??= loadSolanaKit().then((k) => (secret ? k.createKeyPairSignerFromBytes(secret) : k.generateKeyPairSigner())));

  async function sign(tx: UnsignedSolanaTx): Promise<SignedSolanaTx> {
    guardDevnet(tx);
    const k = await loadSolanaKit();
    const me = await keyPair();
    if (tx.fee_payer !== me.address) throw new Error(`solanaLocalSigner: fee_payer ${tx.fee_payer} is not this signer's key ${me.address}`);
    const decoded = k.getTransactionDecoder().decode(k.getBase64Encoder().encode(tx.transaction_base64));
    const signed = await k.partiallySignTransaction([me.keyPair], decoded);
    return { transaction_base64: k.getBase64EncodedWireTransaction(signed), signature: k.getSignatureFromTransaction(signed) };
  }

  const refuseEvm = (): never => {
    throw new Error("solanaLocalSigner signs Solana transactions only");
  };

  return {
    kind: "solana-local",
    async address(_chain: OdaChain) {
      return (await keyPair()).address as unknown as `0x${string}`;
    },
    async publicKey() {
      return (await keyPair()).address;
    },
    async sendTransaction() {
      return refuseEvm();
    },
    async signTypedData() {
      return refuseEvm();
    },
    signSolanaTransaction: sign,
    async sendSolanaTransaction(tx: UnsignedSolanaTx) {
      guardDevnet(tx);
      if (!opts.rpc) throw new Error("solanaLocalSigner: no rpc configured; use signSolanaTransaction or pass rpc");
      const rpc = opts.rpc(tx.chain);
      const genesis = await rpc.request("getGenesisHash", []);
      if (genesis === SOLANA_MAINNET_GENESIS_HASH) throw new Error("solanaLocalSigner: the RPC reports the mainnet-beta genesis hash; refusing");
      const signed = await sign(tx);
      return { signature: await sendSignedSolanaTx(rpc, signed) };
    },
  };
}
