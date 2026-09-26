// SIGNER builder. Helpers shared by the signer adapters. No runtime dependencies.
import type { UnsignedEvmTx } from "../spec/index.js";

/**
 * Chain ids of the mainnets the kit knows. A signer built for fork/testnet use
 * refuses these unless it was explicitly constructed for mainnet.
 * ethereum 1, optimism 10, polygon 137, base 8453, arbitrum 42161.
 */
export const MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([1, 10, 137, 8453, 42161]);

export function isMainnetChainId(id: number): boolean {
  return MAINNET_CHAIN_IDS.has(id);
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Checks the unsigned tx shape before any signer sees it. Throws with a plain message. */
export function assertUnsignedEvmTx(tx: UnsignedEvmTx): void {
  if (!tx || tx.kind !== "evm_tx") throw new Error("signer: expected an unsigned evm_tx");
  if (!Number.isSafeInteger(tx.chain_id) || tx.chain_id <= 0) throw new Error("signer: chain_id must be a positive integer");
  if (!ADDR_RE.test(tx.to)) throw new Error("signer: `to` is not a 20-byte hex address");
  if (!HEX_RE.test(tx.data) || tx.data.length % 2 !== 0) throw new Error("signer: `data` is not 0x-prefixed hex");
  if (!/^\d+$/.test(tx.value)) throw new Error("signer: `value` must be wei as a decimal string");
}

/** Refuses when the tx names a `from` other than the signer's own address. */
export function assertFromMatches(tx: UnsignedEvmTx, address: string): void {
  if (tx.from !== null && tx.from.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`signer: tx.from ${tx.from} is not this signer's address ${address}`);
  }
}
