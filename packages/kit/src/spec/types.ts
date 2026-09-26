// Vendored verbatim into @satohub/kit (packages/kit/src/spec). Edit here, then re-vendor.
/**
 * `sato.action/v1` — the Onchain Action Descriptor (ODA, working name). Draft 0.
 *
 * One descriptor per action the kit (or anyone) exposes: what it is called,
 * what it touches, what it can do with a key and with money, which pre-flight
 * rules it runs, and the exact upstream versions it wraps. Hosts read it to
 * wire approval hooks; Sato Status reads it to check the action nightly.
 *
 * WHY `custody` IS DECLARED PER ACTION: Sato Check (sato.custody/v1,
 * lib/custody/types.ts) asks four questions of a package — does it take your
 * key, does your key leave, can it move funds on its own, what changed. An ODA
 * descriptor answers the first three FOR ONE ACTION, as a declaration. It is
 * the project's statement, never a reading we made: Sato Check's traced and
 * observed lanes are how a declaration gets checked. (The fourth question is a
 * diff between versions, so it has no place in a single descriptor.)
 *
 * WHY `output_schema` IS REQUIRED: hosts now validate structured output, and
 * an action with no declared output cannot be checked by conformance runs.
 *
 * `sponsored` is DATA, never copy. A sponsor never appears in a description
 * (lint.ts refuses it) and has no effect on resolution or ranking.
 *
 * Pure and dependency-free.
 */

import type { PolicyRuleId } from "./policy.js";

export const ACTION_SCHEMA_ID = "sato.action/v1" as const;

/** What an action does, in increasing order of consequence. */
export const ODA_EFFECTS = ["read", "quote", "simulate", "sign", "broadcast", "pay"] as const;
export type OdaEffect = (typeof ODA_EFFECTS)[number];

/** Chains an action may declare. Additive only. */
export const ODA_CHAINS = [
  "ethereum",
  "sepolia",
  "base",
  "base-sepolia",
  "arbitrum",
  "arbitrum-sepolia",
  "optimism",
  "optimism-sepolia",
  "polygon",
  "solana",
  "solana-devnet",
] as const;
export type OdaChain = (typeof ODA_CHAINS)[number];

/**
 * never          — the action cannot move funds (reads, quotes, simulations)
 * with_approval  — it produces something that moves funds only after a person
 *                  or a signer policy approves the specific intent
 * autonomous     — it can move funds with no per-intent approval
 */
export const MOVES_FUNDS = ["never", "with_approval", "autonomous"] as const;
export type MovesFunds = (typeof MOVES_FUNDS)[number];

export type ActionCustody = {
  /** Does the action read key material? (sato.custody/v1 question 1) */
  reads_key: boolean;
  /** Does key material leave the process? (question 2) Any `true` is disclosed as such. */
  sends_key: boolean;
  /** Can it move funds on its own? (question 3) */
  moves_funds: MovesFunds;
};

/** A JSON Schema object. ODA requires it to pass lintPortableSchema (lint.ts). */
export type JsonSchemaObject = { [key: string]: unknown };

export type ActionDescriptor = {
  schema: typeof ACTION_SCHEMA_ID;
  /** Dotted, lowercase: "swap.prepare". See names.ts. */
  id: string;
  /** The tool name every host sees. MUST equal odaIdToToolName(id). */
  name: string;
  /** MAJOR.MINOR.PATCH of this descriptor. */
  version: string;
  title: string;
  /** ≤1000 characters. No dates, counts, prices, sponsorship or claims (lint.ts). */
  description: string;
  /** Non-empty, unique, drawn from ODA_EFFECTS. */
  effects: OdaEffect[];
  custody: ActionCustody;
  chains: OdaChain[];
  input_schema: JsonSchemaObject;
  output_schema: JsonSchemaObject;
  /** Which pre-flight rules this action runs before it returns an intent. */
  policy: { rules: PolicyRuleId[] };
  /** Whether the action writes a sato.receipt/v1 line. */
  receipt: boolean;
  /** Fixture file paths (relative) that conformance runs replay. */
  fixtures: string[];
  /** Package name → EXACT version the action wraps ("viem": "2.21.0"). No ranges. */
  upstream: Record<string, string>;
  /** Who paid to package this action, and since when. null for none. Never in copy. */
  sponsored: { by: string; since: string } | null;
};

export type ApprovalHints = {
  /** MCP annotation: the tool does not modify state. */
  readOnlyHint: boolean;
  /** MCP annotation: repeating the call with the same input has no further effect. */
  idempotentHint: boolean;
  /** MCP annotation: the tool may perform an irreversible update. */
  destructiveHint: boolean;
  /** Map to _meta["anthropic/requiresUserInteraction"], AI SDK toolApproval, OpenAI needsApproval, ADK require_confirmation. */
  requiresUserInteraction: boolean;
};

const PASSIVE: readonly OdaEffect[] = ["read", "quote", "simulate"];
const CONSEQUENTIAL: readonly OdaEffect[] = ["sign", "broadcast", "pay"];

/**
 * Approval hints from effects (scope §16.3):
 *   only read / quote / simulate  → readOnlyHint + idempotentHint
 *   any sign / broadcast / pay    → destructiveHint + requiresUserInteraction
 * `pay` counts with sign/broadcast: it spends. An empty effects list gets the
 * cautious answer (not read-only, needs interaction) — an undeclared action is
 * never waved through.
 */
export function approvalHints(effects: readonly OdaEffect[]): ApprovalHints {
  const passive = effects.length > 0 && effects.every((e) => PASSIVE.includes(e));
  const consequential = effects.length === 0 || effects.some((e) => CONSEQUENTIAL.includes(e));
  return {
    readOnlyHint: passive,
    idempotentHint: passive,
    destructiveHint: consequential,
    requiresUserInteraction: consequential,
  };
}
