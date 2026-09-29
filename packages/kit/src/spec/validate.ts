// Vendored verbatim into @satohub/kit (packages/kit/src/spec). Edit here, then re-vendor.
/**
 * Structural validators for `sato.action/v1` and `sato.receipt/v1`.
 *
 * WHY HAND-WRITTEN (the lib/recipes/schema.ts pattern): the kit vendors this
 * folder and must not pull a JSON Schema engine into every agent that imports
 * it. The published documents (lib/create/schemas/{action,receipt}.v1.json)
 * and these functions are checked against each other in
 * tests/create-contracts.test.ts on shared fixtures, so neither can drift.
 *
 * These decide whether a document is WELL-FORMED. Whether an action's schemas
 * load in every host and its copy follows the rules is lint.ts; whether the
 * action works is Sato Status.
 */

import { ACTION_SCHEMA_ID, MOVES_FUNDS, ODA_CHAINS, ODA_EFFECTS, type ActionDescriptor } from "./types.js";
import { DIGEST_RE, INTENT_ID_RE, RECEIPT_SCHEMA_ID, RECEIPT_STATUSES, UNSIGNED_PAYLOAD_KINDS, type Receipt, type UnsignedPayload } from "./intent.js";
import { isPolicyRuleId } from "./policy.js";
import { ODA_ID_RE, TOOL_NAME_RE } from "./names.js";

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
/** An exact version: MAJOR.MINOR.PATCH with an optional prerelease. No ranges. */
export const EXACT_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${where}: unknown property ${JSON.stringify(k)}`);
}

function need(o: Record<string, unknown>, keys: readonly string[], where: string, errors: string[]): void {
  for (const k of keys) if (!(k in o)) errors.push(`${where}: ${k} is required`);
}

const ACTION_KEYS = [
  "schema", "id", "name", "version", "title", "description", "effects", "custody", "chains",
  "input_schema", "output_schema", "policy", "receipt", "fixtures", "upstream", "sponsored",
] as const;

export function validateActionDescriptor(input: unknown): Validation<ActionDescriptor> {
  const e: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["descriptor must be an object"] };
  onlyKeys(input, ACTION_KEYS, "descriptor", e);
  need(input, ACTION_KEYS, "descriptor", e);
  if (input.schema !== ACTION_SCHEMA_ID) e.push(`schema must be ${JSON.stringify(ACTION_SCHEMA_ID)}`);
  if (typeof input.id !== "string" || !ODA_ID_RE.test(input.id)) e.push("id must be a dotted ODA id");
  if (typeof input.name !== "string" || !TOOL_NAME_RE.test(input.name) || input.name.length > 40) e.push("name must be snake_case, at most 40 characters");
  if (typeof input.version !== "string" || !SEMVER_RE.test(input.version)) e.push("version must be MAJOR.MINOR.PATCH");
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 120) e.push("title must be 1..120 characters");
  if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 1000) e.push("description must be 1..1000 characters");

  const eff = input.effects;
  if (!Array.isArray(eff) || eff.length === 0 || eff.some((x) => !(ODA_EFFECTS as readonly unknown[]).includes(x)) || new Set(eff).size !== eff.length) {
    e.push(`effects must be a non-empty, unique subset of ${ODA_EFFECTS.join(", ")}`);
  }
  const c = input.custody;
  if (!isObj(c)) e.push("custody must be an object");
  else {
    onlyKeys(c, ["reads_key", "sends_key", "moves_funds"], "custody", e);
    if (typeof c.reads_key !== "boolean") e.push("custody.reads_key must be a boolean");
    if (typeof c.sends_key !== "boolean") e.push("custody.sends_key must be a boolean");
    if (!(MOVES_FUNDS as readonly unknown[]).includes(c.moves_funds)) e.push(`custody.moves_funds must be one of ${MOVES_FUNDS.join(", ")}`);
  }
  const ch = input.chains;
  if (!Array.isArray(ch) || ch.length === 0 || ch.some((x) => !(ODA_CHAINS as readonly unknown[]).includes(x)) || new Set(ch).size !== ch.length) {
    e.push("chains must be a non-empty, unique list of ODA chain names");
  }
  if (!isObj(input.input_schema)) e.push("input_schema must be an object");
  if (!isObj(input.output_schema)) e.push("output_schema must be an object");
  const pol = input.policy;
  if (!isObj(pol) || !Array.isArray(pol.rules) || pol.rules.some((r) => !isPolicyRuleId(r))) e.push("policy.rules must list sato.policy/v1 rule ids");
  else onlyKeys(pol, ["rules"], "policy", e);
  if (typeof input.receipt !== "boolean") e.push("receipt must be a boolean");
  if (!Array.isArray(input.fixtures) || input.fixtures.some((f) => typeof f !== "string" || !f || f.startsWith("/") || f.split("/").includes(".."))) {
    e.push("fixtures must be relative paths");
  }
  if (!isObj(input.upstream) || Object.values(input.upstream).some((v) => typeof v !== "string" || !EXACT_VERSION_RE.test(v))) {
    e.push("upstream must map package names to EXACT versions (no ^, ~, *, ranges or tags)");
  }
  const sp = input.sponsored;
  if (sp !== null) {
    if (!isObj(sp) || typeof sp.by !== "string" || !sp.by || typeof sp.since !== "string" || !DATE_RE.test(sp.since)) {
      e.push("sponsored must be null or { by, since: YYYY-MM-DD }");
    } else onlyKeys(sp, ["by", "since"], "sponsored", e);
  }
  return e.length ? { ok: false, errors: e } : { ok: true, value: input as unknown as ActionDescriptor };
}

const RECEIPT_KEYS = [
  "schema", "seq", "prev_hash", "hash", "intent_id", "action", "chain", "params_digest", "policy",
  "simulation", "fee_disclosure", "tx_hash", "status", "created_at", "mandate",
] as const;

/** Optional receipt fields, additive in Phase 2 wave 2. Absent is always valid. */
export const RECEIPT_OPTIONAL_KEYS = ["safe_tx_hash", "signature"] as const;
export const SAFE_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** 64 bytes in base58: 86–88 characters. */
export const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
/** A 32-byte public key or blockhash in base58: 32–44 characters. */
export const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Non-empty, padded standard base64. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/;
const DECIMAL_RE = /^[0-9]+$/;

function positiveInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function payloadEvm(p: Record<string, unknown>, e: string[]): void {
  onlyKeys(p, ["kind", "chain", "chain_id", "from", "to", "data", "value"], "evm_tx", e);
  if (typeof p.chain !== "string" || !p.chain) e.push("evm_tx.chain must be a string");
  if (!positiveInt(p.chain_id)) e.push("evm_tx.chain_id must be a positive integer");
  if (p.from !== null && (typeof p.from !== "string" || !EVM_ADDRESS_RE.test(p.from))) e.push("evm_tx.from must be an address or null");
  if (typeof p.to !== "string" || !EVM_ADDRESS_RE.test(p.to)) e.push("evm_tx.to must be an address");
  if (typeof p.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(p.data)) e.push("evm_tx.data must be 0x-prefixed hex");
  if (typeof p.value !== "string" || !DECIMAL_RE.test(p.value)) e.push("evm_tx.value must be a decimal string");
}

function payloadX402(p: Record<string, unknown>, e: string[]): void {
  onlyKeys(p, ["kind", "network", "resource", "pay_to", "asset", "amount"], "x402_payment", e);
  for (const k of ["network", "resource", "pay_to", "asset"] as const) if (typeof p[k] !== "string" || !p[k]) e.push(`x402_payment.${k} must be a string`);
  if (typeof p.amount !== "string" || !DECIMAL_RE.test(p.amount)) e.push("x402_payment.amount must be a decimal string");
}

function payloadTypedData(p: Record<string, unknown>, e: string[]): void {
  onlyKeys(p, ["kind", "chain", "chain_id", "signer", "domain", "types", "primaryType", "message", "submit"], "typed_data", e);
  need(p, ["submit"], "typed_data", e);
  if (typeof p.chain !== "string" || !p.chain) e.push("typed_data.chain must be a string");
  if (!positiveInt(p.chain_id)) e.push("typed_data.chain_id must be a positive integer");
  if (typeof p.signer !== "string" || !EVM_ADDRESS_RE.test(p.signer)) e.push("typed_data.signer must be an address");
  if (!isObj(p.domain)) e.push("typed_data.domain must be an object");
  if (!isObj(p.message)) e.push("typed_data.message must be an object");
  const t = p.types;
  const typesOk = isObj(t) && Object.values(t).every((fields) => Array.isArray(fields) && fields.every((f) => isObj(f) && typeof f.name === "string" && typeof f.type === "string"));
  if (!typesOk) e.push("typed_data.types must map type names to [{ name, type }]");
  if (typeof p.primaryType !== "string" || !isObj(t) || !Object.prototype.hasOwnProperty.call(t, p.primaryType)) e.push("typed_data.primaryType must name a key of types");
  const s = p.submit;
  if (s !== null && s !== undefined) {
    if (!isObj(s) || s.kind !== "safe_tx_service" || typeof s.url !== "string" || !/^https:\/\/\S+$/.test(s.url) || typeof s.safe_address !== "string" || !EVM_ADDRESS_RE.test(s.safe_address)) {
      e.push("typed_data.submit must be null or { kind: 'safe_tx_service', url: https://…, safe_address }");
    } else onlyKeys(s, ["kind", "url", "safe_address"], "typed_data.submit", e);
  }
}

function payloadSolana(p: Record<string, unknown>, e: string[]): void {
  onlyKeys(p, ["kind", "chain", "fee_payer", "transaction_base64", "recent_blockhash", "last_valid_block_height"], "solana_tx", e);
  if (p.chain !== "solana" && p.chain !== "solana-devnet") e.push("solana_tx.chain must be solana or solana-devnet");
  if (typeof p.fee_payer !== "string" || !SOLANA_PUBKEY_RE.test(p.fee_payer)) e.push("solana_tx.fee_payer must be a base58 public key");
  if (typeof p.transaction_base64 !== "string" || !BASE64_RE.test(p.transaction_base64)) e.push("solana_tx.transaction_base64 must be non-empty base64");
  if (typeof p.recent_blockhash !== "string" || !SOLANA_PUBKEY_RE.test(p.recent_blockhash)) e.push("solana_tx.recent_blockhash must be base58");
  const h = p.last_valid_block_height;
  if (typeof h !== "number" || !Number.isInteger(h) || h < 0) e.push("solana_tx.last_valid_block_height must be a non-negative integer");
}

/**
 * Validates a PreparedIntent's `unsigned` payload. Four kinds: evm_tx and
 * x402_payment (M0), typed_data and solana_tx (additive in Phase 2 wave 2).
 * Any other kind is refused, never passed through.
 */
export function validateUnsignedPayload(input: unknown): Validation<UnsignedPayload> {
  const e: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["unsigned payload must be an object"] };
  switch (input.kind) {
    case "evm_tx": payloadEvm(input, e); break;
    case "x402_payment": payloadX402(input, e); break;
    case "typed_data": payloadTypedData(input, e); break;
    case "solana_tx": payloadSolana(input, e); break;
    default: return { ok: false, errors: [`unsigned.kind must be one of ${UNSIGNED_PAYLOAD_KINDS.join(", ")}`] };
  }
  return e.length ? { ok: false, errors: e } : { ok: true, value: input as unknown as UnsignedPayload };
}

/** Parse helper: the payload, or a throw naming every error. */
export function parseUnsignedPayload(input: unknown): UnsignedPayload {
  const v = validateUnsignedPayload(input);
  if (!v.ok) throw new Error(`invalid unsigned payload: ${v.errors.join("; ")}`);
  return v.value;
}

export function validateReceipt(input: unknown): Validation<Receipt> {
  const e: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["receipt must be an object"] };
  onlyKeys(input, [...RECEIPT_KEYS, ...RECEIPT_OPTIONAL_KEYS], "receipt", e);
  need(input, RECEIPT_KEYS, "receipt", e);
  if ("safe_tx_hash" in input && (typeof input.safe_tx_hash !== "string" || !SAFE_TX_HASH_RE.test(input.safe_tx_hash))) e.push("safe_tx_hash must be 0x + 64 hex");
  if ("signature" in input && (typeof input.signature !== "string" || !SOLANA_SIGNATURE_RE.test(input.signature))) e.push("signature must be a base58 Solana signature");
  if (input.schema !== RECEIPT_SCHEMA_ID) e.push(`schema must be ${JSON.stringify(RECEIPT_SCHEMA_ID)}`);
  if (typeof input.seq !== "number" || !Number.isInteger(input.seq) || input.seq < 0) e.push("seq must be a non-negative integer");
  for (const k of ["prev_hash", "hash", "params_digest"] as const) {
    if (typeof input[k] !== "string" || !DIGEST_RE.test(input[k] as string)) e.push(`${k} must be sha256:<64 hex>`);
  }
  if (typeof input.intent_id !== "string" || !INTENT_ID_RE.test(input.intent_id)) e.push("intent_id must be si_<43 base64url>");
  if (typeof input.action !== "string" || !ODA_ID_RE.test(input.action)) e.push("action must be an ODA id");
  if (typeof input.chain !== "string" || !input.chain) e.push("chain must be a string");
  const pol = input.policy;
  if (!isObj(pol) || typeof pol.ok !== "boolean" || !Array.isArray(pol.refusals)) e.push("policy must be { ok, refusals[] }");
  else {
    for (const [i, r] of pol.refusals.entries()) {
      if (!isObj(r) || !isPolicyRuleId(r.rule) || typeof r.limit !== "string" || typeof r.observed !== "string" || typeof r.message !== "string") {
        e.push(`policy.refusals[${i}] must be { rule, limit, observed, message } with string values`);
      }
    }
  }
  if (input.simulation !== null && !isObj(input.simulation)) e.push("simulation must be an object or null");
  if (input.fee_disclosure !== null && !isObj(input.fee_disclosure)) e.push("fee_disclosure must be an object or null");
  if (input.tx_hash !== null && (typeof input.tx_hash !== "string" || !input.tx_hash)) e.push("tx_hash must be a string or null");
  if (!(RECEIPT_STATUSES as readonly unknown[]).includes(input.status)) e.push(`status must be one of ${RECEIPT_STATUSES.join(", ")}`);
  if (typeof input.created_at !== "string" || !ISO_RE.test(input.created_at)) e.push("created_at must be ISO-8601 UTC");
  const m = input.mandate;
  if (!isObj(m) || m.kind !== "intent" || typeof m.intent_id !== "string" || typeof m.action !== "string" || typeof m.policy_digest !== "string" || !DIGEST_RE.test(m.policy_digest) || typeof m.expires_at !== "string" || !["human", "policy", "none"].includes(m.approval as string)) {
    e.push("mandate must be { kind: 'intent', intent_id, action, policy_digest, expires_at, approval }");
  } else onlyKeys(m, ["kind", "intent_id", "action", "policy_digest", "expires_at", "approval"], "mandate", e);
  return e.length ? { ok: false, errors: e } : { ok: true, value: input as unknown as Receipt };
}
