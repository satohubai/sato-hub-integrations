/**
 * POLICY builder — the sato.policy/v1 pre-flight.
 *
 * This evaluator runs in the agent's own process. It EXPLAINS refusals before
 * anything is signed; it does not enforce them. Enforcement lives in the
 * signer (and its native policy, see ./compile/cdp.ts).
 *
 * Semantics (spec/policy.ts): strict on unknown, permissive on empty. An empty
 * allowlist means any. A fact the action did not supply (no contract, no
 * recipient, no venue, no slippage) means the rule does not apply to this
 * action. A value the policy needs but could not be read is never treated as
 * zero: `unknown_verdict` decides, default refuse.
 *
 * Venue neutrality (scope §0.3): the venue is read by exactly one rule,
 * venue_allowlist. No other rule looks at it.
 *
 * Pure: same policy + facts -> same result. Refusals are sorted by rule id.
 */
import { allowlistPermits, BASE_UNITS_RE } from "../spec/index.js";
import type { PolicyRuleId, Refusal } from "../spec/index.js";
import type { EvaluatePreflight, PreflightFacts, PreflightResult } from "../types.js";

const UNKNOWN = "unknown";

function str(v: unknown): string {
  if (v === undefined || v === null) return UNKNOWN;
  if (typeof v === "number" && !Number.isFinite(v)) return UNKNOWN;
  const s = String(v);
  return s.length === 0 ? UNKNOWN : s;
}

function refusal(rule: PolicyRuleId, limit: unknown, observed: unknown, message: string): Refusal {
  return { rule, limit: str(limit), observed: str(observed), message };
}

function listLimit(list: readonly string[]): string {
  return list.length === 0 ? "any" : list.join(",");
}

function isUsd(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function lookupCap(caps: Record<string, string>, key: string): string | undefined {
  const k = key.toLowerCase();
  const keys = Object.keys(caps).sort();
  for (const c of keys) if (c.toLowerCase() === k) return caps[c];
  return undefined;
}

export const evaluatePreflight: EvaluatePreflight = (policy, facts: PreflightFacts): PreflightResult => {
  const out: Refusal[] = [];
  const refuseUnknown = policy.unknown_verdict !== "allow";

  // network
  if (facts.network === "mainnet" && policy.network !== "mainnet") {
    out.push(refusal("network_mainnet_not_enabled", policy.network, facts.network,
      `The intent targets mainnet and the policy's network is ${policy.network}.`));
  }

  // allowlists
  if (!allowlistPermits(policy.allow_chains, facts.chain)) {
    out.push(refusal("chain_allowlist", listLimit(policy.allow_chains), facts.chain,
      `Chain ${facts.chain} is not in allow_chains.`));
  }
  if (policy.allow_tokens.length > 0 && facts.token !== undefined) {
    const v = `${facts.chain}:${facts.token}`;
    if (!allowlistPermits(policy.allow_tokens, v)) {
      out.push(refusal("token_allowlist", listLimit(policy.allow_tokens), v, `Token ${v} is not in allow_tokens.`));
    }
  }
  if (facts.contract !== undefined) {
    const v = `${facts.chain}:${facts.contract}`;
    if (!allowlistPermits(policy.allow_contracts, v)) {
      out.push(refusal("contract_allowlist", listLimit(policy.allow_contracts), v, `Contract ${v} is not in allow_contracts.`));
    }
  }
  if (facts.recipient !== undefined) {
    const v = `${facts.chain}:${facts.recipient}`;
    if (!allowlistPermits(policy.allow_recipients, v)) {
      out.push(refusal("recipient_allowlist", listLimit(policy.allow_recipients), v, `Recipient ${v} is not in allow_recipients.`));
    }
  }
  if (facts.venue !== undefined && !allowlistPermits(policy.allow_venues, facts.venue)) {
    out.push(refusal("venue_allowlist", listLimit(policy.allow_venues), facts.venue, `Venue ${facts.venue} is not in allow_venues.`));
  }

  // USD caps
  const priceKnown = isUsd(facts.usd_value);
  if (policy.max_usd_per_trade !== null) {
    if (!priceKnown) {
      if (refuseUnknown) out.push(refusal("unknown_price", policy.max_usd_per_trade, UNKNOWN,
        `max_usd_per_trade is ${policy.max_usd_per_trade} and no price was available to read the trade's USD value.`));
    } else if ((facts.usd_value as number) > policy.max_usd_per_trade) {
      out.push(refusal("max_usd_per_trade", policy.max_usd_per_trade, facts.usd_value,
        `The trade's USD value ${facts.usd_value} is over max_usd_per_trade ${policy.max_usd_per_trade}.`));
    }
  }
  if (policy.max_usd_per_day !== null) {
    if (!priceKnown) {
      // one unknown_price refusal names every cap it blocks
      if (refuseUnknown && policy.max_usd_per_trade === null) out.push(refusal("unknown_price", policy.max_usd_per_day, UNKNOWN,
        `max_usd_per_day is ${policy.max_usd_per_day} and no price was available to read the trade's USD value.`));
    } else if (!isUsd(facts.usd_spent_today)) {
      if (refuseUnknown) out.push(refusal("unknown_verdict", policy.max_usd_per_day, UNKNOWN,
        `max_usd_per_day is ${policy.max_usd_per_day} and the USD already spent today could not be read.`));
    } else {
      const total = (facts.usd_spent_today as number) + (facts.usd_value as number);
      if (total > policy.max_usd_per_day) {
        out.push(refusal("max_usd_per_day", policy.max_usd_per_day, total,
          `The day's USD total including this trade, ${total}, is over max_usd_per_day ${policy.max_usd_per_day}.`));
      }
    }
  }

  // base-unit cap
  if (facts.token !== undefined) {
    const key = `${facts.chain}:${facts.token}`;
    const cap = lookupCap(policy.max_per_trade, key);
    if (cap !== undefined) {
      const amt = facts.token_amount_base_units;
      if (amt === undefined || !BASE_UNITS_RE.test(amt)) {
        if (refuseUnknown) out.push(refusal("unknown_verdict", cap, UNKNOWN,
          `max_per_trade for ${key} is ${cap} and the trade's base-unit amount could not be read.`));
      } else if (BigInt(amt) > BigInt(cap)) {
        out.push(refusal("max_per_trade", cap, amt, `The trade's amount ${amt} of ${key} is over its max_per_trade ${cap}.`));
      }
    }
  }

  // slippage
  if (policy.max_slippage_bps !== null && facts.slippage_bps !== undefined) {
    const s = facts.slippage_bps;
    if (typeof s !== "number" || !Number.isFinite(s)) {
      if (refuseUnknown) out.push(refusal("unknown_verdict", policy.max_slippage_bps, UNKNOWN,
        `max_slippage_bps is ${policy.max_slippage_bps} and the requested slippage could not be read.`));
    } else if (s > policy.max_slippage_bps) {
      out.push(refusal("max_slippage_bps", policy.max_slippage_bps, s,
        `The requested slippage ${s} bps is over max_slippage_bps ${policy.max_slippage_bps}.`));
    }
  }

  // ttl
  const ttl = facts.ttl_s;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0 || ttl > policy.intent_ttl_s) {
    out.push(refusal("intent_ttl", policy.intent_ttl_s, ttl,
      `The requested intent lifetime ${str(ttl)} s is not within 1..${policy.intent_ttl_s} s.`));
  }

  // simulation (require_simulation is a constant true)
  if (facts.simulation === null || facts.simulation === undefined) {
    out.push(refusal("simulation_required", "required", "none", "No simulation result is attached to the intent."));
  } else if (facts.simulation.ok !== true) {
    out.push(refusal("simulation_failed", "ok", facts.simulation.error ?? "failed",
      `The simulation (${str(facts.simulation.method)}) did not succeed: ${facts.simulation.error ?? "no reason given"}.`));
  }

  out.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
  return { ok: out.length === 0, refusals: out };
};
