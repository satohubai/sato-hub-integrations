// Sato Kit as the budget gate in front of an x402 payment.
//
// 1. preflightPayment() runs the kit's x402.prepare: it fetches the resource,
//    reads what the 402 asks for, and checks the first acceptable requirement
//    against policy.json (network, chain and recipient allowlists, per-trade and
//    per-day USD caps, unknown price → refuse). A refusal names each rule.
// 2. Only when that passes does the agent pay, and onlyApprovedRequirement()
//    is registered on the x402 client as a PaymentPolicy, so the client can pay
//    the requirement the pre-flight approved and nothing else.
//
// This file imports only the kit, so it typechecks and tests without the
// Workers runtime. The pre-flight explains refusals before any signature; the
// key and any limits it enforces stay with the signer.
import { createKit, parsePolicyFile, x402PrepareAction } from "@satohub/kit";
import type { Kit, PreparedIntent, Refusal, UnsignedX402Payment } from "@satohub/kit";

export const EXAMPLE_USER_AGENT = "sato-cloudflare-agents-x402-example/0.1.0";

export type BuildOptions = { policy: unknown; fetch?: typeof fetch; clock?: () => number };

export function buildX402Kit(opts: BuildOptions): Kit {
  const parsed = parsePolicyFile(opts.policy ?? {});
  if (!parsed.ok) throw new Error(`policy: ${parsed.error}`);
  return createKit({
    policy: parsed.policy,
    actions: [x402PrepareAction()],
    rpc: () => {
      throw new Error("x402.prepare reads no chain state");
    },
    fetch: opts.fetch,
    clock: opts.clock,
    userAgent: EXAMPLE_USER_AGENT,
  });
}

export type Preflight =
  | { ok: true; intent: PreparedIntent; approved: UnsignedX402Payment }
  | { ok: false; error: string; refusals: Refusal[]; intent?: PreparedIntent };

export async function preflightPayment(kit: Kit, req: { url: string; maxAmountBaseUnits: string }): Promise<Preflight> {
  let intent: PreparedIntent;
  try {
    intent = await kit.prepare("x402.prepare", { url: req.url, max_amount_base_units: req.maxAmountBaseUnits });
  } catch (e) {
    const refusals = (e as { refusals?: Refusal[] }).refusals ?? [];
    return { ok: false, error: e instanceof Error ? e.message : String(e), refusals };
  }
  if (!intent.policy.ok) return { ok: false, error: "refused by the policy pre-flight", refusals: intent.policy.refusals, intent };
  if (intent.unsigned.kind !== "x402_payment") return { ok: false, error: "not an x402 payment", refusals: [], intent };
  return { ok: true, intent, approved: intent.unsigned };
}

/** The fields of an x402 payment requirement this filter reads (v2 `amount`, v1 `maxAmountRequired`). */
export type RequirementLike = { network: string; asset: string; payTo: string; amount?: string; maxAmountRequired?: string };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * An x402 client PaymentPolicy: keeps only the requirement the pre-flight
 * approved (same network, asset, recipient and amount). Register it with
 * `client.registerPolicy(onlyApprovedRequirement(approved))`. If the server
 * changed its terms between the pre-flight and the payment, nothing is left
 * and the client pays nothing.
 */
export function onlyApprovedRequirement(approved: UnsignedX402Payment) {
  return <R extends RequirementLike>(_x402Version: number, reqs: R[]): R[] =>
    reqs.filter(
      (r) =>
        r.network === approved.network &&
        same(r.asset, approved.asset) &&
        same(r.payTo, approved.pay_to) &&
        (r.amount ?? r.maxAmountRequired) === approved.amount,
    );
}
