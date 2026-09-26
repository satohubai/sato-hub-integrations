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
import { DIGEST_RE, INTENT_ID_RE, RECEIPT_SCHEMA_ID, RECEIPT_STATUSES, type Receipt } from "./intent.js";
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

export function validateReceipt(input: unknown): Validation<Receipt> {
  const e: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["receipt must be an object"] };
  onlyKeys(input, RECEIPT_KEYS, "receipt", e);
  need(input, RECEIPT_KEYS, "receipt", e);
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
