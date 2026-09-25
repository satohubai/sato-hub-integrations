// The spending policy, and a wallet that can do nothing the policy forbids.
//
// This wallet holds NO private key. It has no sign method and no broadcast
// method, so "sign" and "broadcast" are refused by construction as well as by
// rule. What it can do is answer one question before the agent acts: is this
// intent inside the policy? Every refusal names the rule, the limit and the
// value it saw, so a log line says why without anyone re-deriving it.
//
// To make it act, replace it with a signer that enforces its policy where the
// key lives (a server-side policy engine), not in this process. See README.

import type { Address } from "viem";

export const BASE_CHAIN_ID = 8453;

export const TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // native USDC on Base, 6 decimals
  WETH: "0x4200000000000000000000000000000000000006", // WETH on Base, 18 decimals
} as const satisfies Record<string, Address>;

export type Action = "read" | "quote" | "sign" | "broadcast";

export type Policy = {
  chainId: number;
  actions: readonly Action[];
  /** Tokens the agent may quote in or out of. Anything else is refused. */
  tokens: readonly Address[];
  /** Largest input the agent may even ask a quote for, in USD. */
  maxAmountInUsd: number;
};

export type Intent = {
  action: Action;
  chainId: number;
  tokenIn?: Address;
  tokenOut?: Address;
  amountInUsd?: number;
};

export type Decision =
  | { allowed: true }
  | { allowed: false; rule: string; limit: string; observed: string };

export const DEFAULT_POLICY: Policy = {
  chainId: BASE_CHAIN_ID,
  actions: ["read", "quote"],
  tokens: [TOKENS.USDC, TOKENS.WETH],
  maxAmountInUsd: 25,
};

const lower = (a: string) => a.toLowerCase();

export function evaluate(policy: Policy, intent: Intent): Decision {
  if (!policy.actions.includes(intent.action)) {
    return { allowed: false, rule: "P1-action", limit: policy.actions.join(","), observed: intent.action };
  }
  if (intent.chainId !== policy.chainId) {
    return { allowed: false, rule: "P2-chain", limit: String(policy.chainId), observed: String(intent.chainId) };
  }
  if (intent.action === "quote") {
    const allowed = policy.tokens.map(lower);
    for (const t of [intent.tokenIn, intent.tokenOut]) {
      if (!t || !allowed.includes(lower(t))) {
        return { allowed: false, rule: "P3-token", limit: policy.tokens.join(","), observed: String(t) };
      }
    }
    const usd = intent.amountInUsd;
    // Unknown size refuses: "we did not check" must never read as "it is fine".
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > policy.maxAmountInUsd) {
      return { allowed: false, rule: "P4-size", limit: `<= ${policy.maxAmountInUsd} USD`, observed: String(usd) };
    }
  }
  return { allowed: true };
}

/** A wallet with an optional public address and no key. */
export class PolicyWallet {
  constructor(
    readonly policy: Policy = DEFAULT_POLICY,
    readonly address: Address | null = null,
  ) {}

  authorize(intent: Intent): Decision {
    return evaluate(this.policy, intent);
  }
}
