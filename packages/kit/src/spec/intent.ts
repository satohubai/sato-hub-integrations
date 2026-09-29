// Vendored verbatim into @satohub/kit (packages/kit/src/spec). Edit here, then re-vendor.
/**
 * prepare → execute(intent_id), and the receipt line each step writes.
 *
 * WHY TWO STEPS: every plan that moved funds hand-built quote-bound approval
 * and idempotent execution (scope §0.1). `prepare` does all the thinking —
 * quote, pre-flight, simulation, fee disclosure, the unsigned payload — and
 * hands back an opaque `intent_id`. `execute` takes THAT ID AND NOTHING ELSE.
 * A caller cannot change an amount, a recipient or a venue between approval
 * and signature, because execute has no parameter to change it with. That is
 * the whole design; `EXECUTE_REQUEST_KEYS` exists so a test can assert it.
 *
 * THE intent_id CONTRACT:
 *   mac       = HMAC-SHA256(secret, canonicalJson({ action, params_digest, expires_at, nonce }))
 *   intent_id = "si_" + base64url(mac)          (no padding; 43 characters after the prefix)
 * `params_digest` is "sha256:<hex>" of canonicalJson(the bound parameters).
 * `expires_at` is ISO-8601 UTC; `nonce` is ≥16 random bytes, base64url.
 * The secret never leaves the process that minted the id; the kit keeps the
 * (id → prepared intent) record and refuses an id it did not mint, an expired
 * id, or an id already executed (exactly-once). The MAC itself is computed in
 * the kit with node:crypto — this file fixes the bytes it covers.
 *
 * THE RECEIPT CHAIN (a local, append-only JSONL log):
 *   hash      = "sha256:" + hex(sha256(canonicalJson(receipt without `hash`)))
 *   prev_hash = the previous line's hash; RECEIPT_GENESIS_PREV_HASH for seq 0
 *   seq       = 0, 1, 2 … with no gaps
 * Editing or dropping a line breaks every hash after it. A local chain proves
 * the log was not edited after the fact by someone without the whole file; it
 * is not an attestation and is never described as one.
 *
 * THE `mandate` BLOCK is ALIGNED WITH the AP2 v0.2 / Verifiable Intent
 * vocabulary (an intent mandate: what was asked, under which constraints, until
 * when, and whether a person approved it). It is NOT a certified or complete
 * implementation of either, and must not be presented as one.
 *
 * Pure and dependency-free.
 */

import { canonicalJson } from "./canonical.js";
import type { Refusal } from "./policy.js";

export const RECEIPT_SCHEMA_ID = "sato.receipt/v1" as const;
export const INTENT_ID_PREFIX = "si_" as const;
/** 32 MAC bytes → 43 base64url characters, no padding. */
export const INTENT_ID_RE = /^si_[A-Za-z0-9_-]{43}$/;
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const RECEIPT_GENESIS_PREV_HASH = `sha256:${"0".repeat(64)}` as const;

/** execute accepts exactly these keys. Any other key is refused, not ignored. */
export const EXECUTE_REQUEST_KEYS = ["intent_id"] as const;
export type ExecuteRequest = { intent_id: string };

/** The fields the intent MAC covers, in the canonical object. */
export type IntentIdFields = {
  /** ODA id, e.g. "swap.prepare". */
  action: string;
  /** "sha256:<hex>" of canonicalJson(bound params). */
  params_digest: string;
  /** ISO-8601 UTC. */
  expires_at: string;
  /** base64url of ≥16 random bytes. */
  nonce: string;
};

/** The exact string the HMAC is computed over. */
export function intentIdMacInput(f: IntentIdFields): string {
  return canonicalJson({ action: f.action, params_digest: f.params_digest, expires_at: f.expires_at, nonce: f.nonce });
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding — pure, so this folder needs no Buffer. */
export function base64url(bytes: Uint8Array): string {
  // `b` and `c` read with a fallback so the file compiles under noUncheckedIndexedAccess (the kit enables it).
  const b = (k: number): number => bytes[k] ?? 0;
  const c = (k: number): string => B64URL.charAt(k);
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (b(i) << 16) | (b(i + 1) << 8) | b(i + 2);
    out += c((n >> 18) & 63) + c((n >> 12) & 63) + c((n >> 6) & 63) + c(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = b(i) << 16;
    out += c((n >> 18) & 63) + c((n >> 12) & 63);
  } else if (rest === 2) {
    const n = (b(i) << 16) | (b(i + 1) << 8);
    out += c((n >> 18) & 63) + c((n >> 12) & 63) + c((n >> 6) & 63);
  }
  return out;
}

/** "si_" + base64url(mac). Throws unless the MAC is 32 bytes (HMAC-SHA256). */
export function formatIntentId(mac: Uint8Array): string {
  if (mac.length !== 32) throw new Error(`formatIntentId: expected a 32-byte HMAC-SHA256, got ${mac.length} bytes`);
  return INTENT_ID_PREFIX + base64url(mac);
}

export function isIntentId(v: unknown): v is string {
  return typeof v === "string" && INTENT_ID_RE.test(v);
}

/** Refuses any key other than intent_id, and a malformed id. */
export function parseExecuteRequest(input: unknown): { ok: true; request: ExecuteRequest } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "execute takes an object { intent_id }" };
  const extra = Object.keys(input).filter((k) => !(EXECUTE_REQUEST_KEYS as readonly string[]).includes(k));
  if (extra.length) {
    return { ok: false, error: `execute takes only intent_id; refused ${extra.map((k) => JSON.stringify(k)).join(", ")} — change the intent by preparing a new one` };
  }
  const id = (input as Record<string, unknown>).intent_id;
  if (!isIntentId(id)) return { ok: false, error: "intent_id must be \"si_\" followed by 43 base64url characters" };
  return { ok: true, request: { intent_id: id } };
}

// ── what prepare returns ─────────────────────────────────────────────────────

export type SimulationResult = {
  ok: boolean;
  /** How it was simulated, e.g. "eth_call", "anvil_fork", "eth_simulateV1". */
  method: string;
  /** Block number simulated against, as a decimal string; null when not applicable. */
  block: string | null;
  gas_estimate: string | null;
  /** Revert reason or error text when ok is false; null otherwise. */
  error: string | null;
  as_of: string;
};

/**
 * The fee the user pays for this intent, stated per venue. `statement` is the
 * venue's disclosure quoted verbatim. `direct_quote_available` records whether
 * a quote with no Sato fee was returned alongside (scope §0.3). It is never
 * called "fee-free": the other venue may charge its own fee.
 */
export type FeeDisclosure = {
  venue: string;
  fee_bps: number | null;
  fee_recipient: string | null;
  statement: string;
  direct_quote_available: boolean;
};

export type UnsignedEvmTx = {
  kind: "evm_tx";
  chain: string;
  chain_id: number;
  from: string | null;
  to: string;
  /** 0x-prefixed calldata. */
  data: string;
  /** Wei as a decimal string. */
  value: string;
};

export type UnsignedX402Payment = {
  kind: "x402_payment";
  /** x402 network id as the resource states it. */
  network: string;
  resource: string;
  pay_to: string;
  asset: string;
  /** Base units as a decimal string. */
  amount: string;
};

/**
 * Where a signed typed-data message goes after signing. Only the Safe
 * Transaction Service is defined: the signature is a Safe owner's proposal or
 * confirmation, and nothing moves until the Safe's owners execute it.
 * (Additive in Phase 2 wave 2.)
 */
export type TypedDataSubmit = { kind: "safe_tx_service"; url: string; safe_address: string };

/**
 * EIP-712 typed data to sign (additive in Phase 2 wave 2). `simulation_required`
 * does NOT apply: signing has no on-chain effect until the Safe's owners
 * execute the transaction, so a prepared intent states that reason instead of
 * reporting a simulation (the same pattern as x402_payment), never a faked one.
 * execute = signer.signTypedData, then a POST to the Safe Transaction Service
 * when `submit` is set.
 */
export type UnsignedTypedData = {
  kind: "typed_data";
  chain: string;
  chain_id: number;
  /** The address expected to sign (a Safe owner for safe_tx_service). */
  signer: string;
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
  /** null: return the signature only; otherwise submit it where this says. */
  submit: TypedDataSubmit | null;
};

/**
 * A serialized UNSIGNED Solana transaction (additive in Phase 2 wave 2).
 * Simulated with the RPC's simulateTransaction (sigVerify false) and must
 * succeed, like evm_tx. Executing it needs the signer's OPTIONAL
 * signSolanaTransaction / sendSolanaTransaction capability; a signer without
 * it fails with an error naming the capability.
 */
export type UnsignedSolanaTx = {
  kind: "solana_tx";
  chain: "solana" | "solana-devnet";
  /** base58 public key paying the fee. */
  fee_payer: string;
  /** base64 of the serialized unsigned transaction. */
  transaction_base64: string;
  recent_blockhash: string;
  /** Last block height at which recent_blockhash is still valid (an integer). */
  last_valid_block_height: number;
};

export type UnsignedPayload = UnsignedEvmTx | UnsignedX402Payment | UnsignedTypedData | UnsignedSolanaTx;

export const UNSIGNED_PAYLOAD_KINDS = ["evm_tx", "x402_payment", "typed_data", "solana_tx"] as const;
export type UnsignedPayloadKind = (typeof UNSIGNED_PAYLOAD_KINDS)[number];

export type PreparedIntent = {
  intent_id: string;
  /** ODA id of the action that prepared it. */
  action: string;
  expires_at: string;
  /** One plain sentence a person can approve or refuse. */
  summary: string;
  policy: { ok: boolean; refusals: Refusal[] };
  /** null only when the policy refused before simulation could run. */
  simulation: SimulationResult | null;
  fee_disclosure: FeeDisclosure | null;
  /** What execute would hand the signer. Present even on refusal, for inspection. */
  unsigned: UnsignedPayload;
};

// ── the receipt line ─────────────────────────────────────────────────────────

export const RECEIPT_STATUSES = ["prepared", "refused", "executed", "failed", "expired"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Aligned with AP2 v0.2 / Verifiable Intent intent-mandate vocabulary. Not a certified implementation of either. */
export type IntentMandate = {
  kind: "intent";
  intent_id: string;
  action: string;
  /** "sha256:<hex>" of the policy file in force. */
  policy_digest: string;
  expires_at: string;
  /** "human" when a person approved this specific intent; "policy" when the signer policy alone did. */
  approval: "human" | "policy" | "none";
};

export type Receipt = {
  schema: typeof RECEIPT_SCHEMA_ID;
  seq: number;
  prev_hash: string;
  hash: string;
  intent_id: string;
  action: string;
  chain: string;
  params_digest: string;
  policy: { ok: boolean; refusals: Refusal[] };
  simulation: SimulationResult | null;
  fee_disclosure: FeeDisclosure | null;
  /** The EVM transaction hash (evm_tx). Never reused for a Safe proposal or a Solana signature. */
  tx_hash: string | null;
  status: ReceiptStatus;
  created_at: string;
  mandate: IntentMandate;
  /**
   * OPTIONAL (additive in Phase 2 wave 2). typed_data submitted to the Safe
   * Transaction Service: the 0x-prefixed 32-byte safeTxHash of the proposal.
   * It is not an on-chain transaction, so tx_hash stays null alongside it.
   */
  safe_tx_hash?: string;
  /** OPTIONAL (additive in Phase 2 wave 2). solana_tx: the base58 transaction signature. */
  signature?: string;
};

/** The exact string whose sha256 is the receipt's `hash`: the receipt minus `hash`. */
export function receiptHashInput(r: Omit<Receipt, "hash"> | Receipt): string {
  const { hash: _drop, ...rest } = r as Receipt;
  void _drop;
  return canonicalJson(rest);
}

/**
 * Checks the chain's LINKAGE (seq, prev_hash) given each line's recomputed hash.
 * `sha256` is injected so this stays dependency-free; the kit passes node:crypto.
 * Returns the index of the first bad line, or -1 when the chain holds.
 */
export function firstBrokenLink(lines: readonly Receipt[], sha256Hex: (s: string) => string): number {
  let prev: string = RECEIPT_GENESIS_PREV_HASH;
  for (let i = 0; i < lines.length; i++) {
    const r = lines[i];
    if (!r) return i;
    if (r.seq !== i || r.prev_hash !== prev) return i;
    if (r.hash !== `sha256:${sha256Hex(receiptHashInput(r))}`) return i;
    prev = r.hash;
  }
  return -1;
}
