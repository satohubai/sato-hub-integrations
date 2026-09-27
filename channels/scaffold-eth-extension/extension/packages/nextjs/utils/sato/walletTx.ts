// Browser half of the Sato Kit glue: types and the one function that turns
// a reviewed intent into a wallet request. Imports only TYPES from the kit, so
// nothing from the kit's server code reaches the browser bundle.
import type { PreparedIntent, Refusal } from "@satohub/kit";

export type GuardedSwapInput = {
  chain: string;
  sell_token: string;
  buy_token: string;
  sell_amount: string;
  taker: string;
  slippage_bps?: number;
  venue?: "sato" | "lifi" | "direct" | "0x";
};

export type GuardedSwapResult =
  | { ok: true; intent: PreparedIntent }
  | { ok: false; error: string; refusals?: Refusal[] };

export type WalletTx = { to: `0x${string}`; data: `0x${string}`; value: bigint; chainId: number };

/**
 * The only way this extension turns an intent into a wallet request. Returns
 * { blocked: reason } — and the page shows the reason — unless the pre-flight
 * passed, the simulation succeeded and the intent has not expired.
 */
export function walletTxFor(intent: PreparedIntent, now: number = Date.now()): { tx: WalletTx } | { blocked: string } {
  if (!intent.policy.ok) return { blocked: "the policy pre-flight refused this intent" };
  if (!intent.simulation || !intent.simulation.ok) return { blocked: "the simulation did not succeed" };
  if (Date.parse(intent.expires_at) <= now) return { blocked: "the intent expired; prepare it again" };
  const u = intent.unsigned;
  if (u.kind !== "evm_tx") return { blocked: "this intent is not an EVM transaction" };
  return {
    tx: { to: u.to as `0x${string}`, data: u.data as `0x${string}`, value: BigInt(u.value), chainId: u.chain_id },
  };
}
