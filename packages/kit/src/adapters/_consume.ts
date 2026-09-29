// ADAPTERS — shared, pure pieces of the migration-window consumers
// (agentkit-consume.ts, goat-consume.ts): zod -> portable JSON Schema, the
// pre-flight facts read off a captured transaction, and id segments. No
// framework import here, so each consumer loads only its own framework.
import { decodeFunctionData, erc20Abi } from "viem";
import { z } from "zod";
import { lintPortableSchema } from "../spec/index.js";
import type { JsonSchemaObject, UnsignedEvmTx } from "../spec/index.js";
import type { PreflightFacts } from "../types.js";
import type { EvmChain } from "../actions/_util.js";

const AMOUNT_NAME = /^(amount|amount_.+|value|.+_wei|.+_base_units|uint256)$/;
/** A decimal number, for frameworks that parse amounts as decimals. */
export const DECIMAL_PATTERN = "^[0-9]+(\\.[0-9]+)?$";
/** An integer in base units, for frameworks that pass amounts straight to the ABI. */
export const BASE_UNITS_PATTERN = "^[0-9]+$";
/** A hex EVM address. */
export const EVM_ADDRESS_PATTERN = "^0x[0-9a-fA-F]{40}$";
// Mirrors ADDRESS_NAME in spec/lint.ts.
const ADDRESS_NAME = /^(address|.+_address|to|from|token|recipient)$/;

export const NATIVE_SYMBOL: Record<EvmChain, string> = {
  ethereum: "ETH", sepolia: "ETH", base: "ETH", "base-sepolia": "ETH", arbitrum: "ETH",
  "arbitrum-sepolia": "ETH", optimism: "ETH", "optimism-sepolia": "ETH", polygon: "POL",
};


// ── zod -> portable JSON Schema ────────────────────────────────────────────────

class NotPortable extends Error {}

function zod3ToJson(s: any, path: string): { schema: Record<string, unknown>; optional: boolean } {
  const def = s?._def;
  const t = def?.typeName as string | undefined;
  const withDesc = (o: Record<string, unknown>) => (typeof def?.description === "string" ? { ...o, description: def.description } : o);
  switch (t) {
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape ?? {})) {
        const r = zod3ToJson(v, `${path}.${k}`);
        properties[k] = r.schema;
        if (!r.optional) required.push(k);
      }
      const o: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
      if (required.length) o.required = required;
      return { schema: withDesc(o), optional: false };
    }
    case "ZodString": {
      const o: Record<string, unknown> = { type: "string" };
      for (const c of def.checks ?? []) {
        if (c.kind === "regex") {
          if (o.pattern) throw new NotPortable(`${path}: more than one pattern`);
          o.pattern = (c.regex as RegExp).source;
        } else if (c.kind === "min") o.minLength = c.value;
        else if (c.kind === "max") o.maxLength = c.value;
        else if (c.kind === "length") { o.minLength = c.value; o.maxLength = c.value; }
      }
      return { schema: withDesc(o), optional: false };
    }
    case "ZodNumber": {
      const o: Record<string, unknown> = { type: (def.checks ?? []).some((c: any) => c.kind === "int") ? "integer" : "number" };
      for (const c of def.checks ?? []) {
        if (c.kind === "min") o[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
        if (c.kind === "max") o[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
      }
      return { schema: withDesc(o), optional: false };
    }
    case "ZodBoolean":
      return { schema: withDesc({ type: "boolean" }), optional: false };
    case "ZodEnum":
      return { schema: withDesc({ type: "string", enum: [...def.values] }), optional: false };
    case "ZodLiteral": {
      const v = def.value;
      const ty = typeof v;
      if (ty !== "string" && ty !== "number" && ty !== "boolean") throw new NotPortable(`${path}: literal of type ${ty}`);
      return { schema: withDesc({ type: ty, enum: [v] }), optional: false };
    }
    case "ZodArray": {
      const r = zod3ToJson(def.type, `${path}[]`);
      return { schema: withDesc({ type: "array", items: r.schema }), optional: false };
    }
    case "ZodOptional": {
      const r = zod3ToJson(def.innerType, path);
      return { schema: typeof def.description === "string" ? { ...r.schema, description: def.description } : r.schema, optional: true };
    }
    case "ZodDefault": {
      const r = zod3ToJson(def.innerType, path);
      return { schema: withDesc({ ...r.schema, default: def.defaultValue() }), optional: true };
    }
    case "ZodEffects": {
      // refine / transform / preprocess: the input shape is the inner schema's; the provider's own parse still runs.
      const r = zod3ToJson(def.schema, path);
      return { schema: withDesc(r.schema), optional: r.optional };
    }
    default:
      throw new NotPortable(`${path}: ${t ?? "unknown zod type"} has no portable JSON Schema form`);
  }
}

type TightenOpts = { amountPattern: string; addressPattern?: string };

function tighten(node: Record<string, unknown>, path: string, out: string[], o: TightenOpts): void {
  const props = node.properties as Record<string, Record<string, unknown>> | undefined;
  if (props && typeof props === "object") {
    for (const [k, v] of Object.entries(props)) {
      if (!v || typeof v !== "object") continue;
      if (AMOUNT_NAME.test(k) && v.type === "string" && typeof v.pattern !== "string") {
        v.pattern = o.amountPattern;
        out.push(`${path}.${k}`);
      } else if (o.addressPattern && ADDRESS_NAME.test(k) && v.type === "string" && typeof v.pattern !== "string") {
        v.pattern = o.addressPattern;
        out.push(`${path}.${k}`);
      }
      tighten(v, `${path}.${k}`, out, o);
    }
  }
  if (node.items && typeof node.items === "object") tighten(node.items as Record<string, unknown>, `${path}[]`, out, o);
}

/**
 * A zod (v3 or v4) schema as a portable JSON Schema, or the reasons it is not
 * one. An amount-named string with no pattern is narrowed to `amountPattern`;
 * with `addressPattern`, an address-named string with no pattern (the lint's
 * address names) is narrowed to it. Every narrowing is listed in `tightened`.
 */
export function zodToPortable(schema: unknown, amountPattern: string, addressPattern?: string): { ok: true; schema: JsonSchemaObject; tightened: string[] } | { ok: false; reason: string } {
  let json: Record<string, unknown>;
  try {
    if (schema && typeof schema === "object" && "_zod" in schema) {
      json = z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "throw" }) as Record<string, unknown>;
      delete json.$schema;
    } else {
      json = zod3ToJson(schema, "$").schema;
    }
  } catch (e) {
    return { ok: false, reason: `schema not convertible: ${e instanceof Error ? e.message : String(e)}` };
  }
  const tightened: string[] = [];
  tighten(json, "$", tightened, { amountPattern, addressPattern });
  const issues = lintPortableSchema(json);
  if (issues.length) return { ok: false, reason: `schema not portable: ${issues.map((i) => `${i.path} ${i.rule}`).join("; ")}` };
  return { ok: true, schema: json as JsonSchemaObject, tightened };
}

export function segment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([0-9])/, "a$1");
}

export function toBig(v: unknown): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return BigInt(v);
  throw new Error(`value ${String(v)} is not an integer amount`);
}

/** What the pre-flight can read off the captured transaction. Unknown stays absent or null. */
export function factsFromTx(chain: EvmChain, u: UnsignedEvmTx): Pick<PreflightFacts, "token" | "token_amount_base_units" | "contract" | "recipient"> {
  const data = u.data as `0x${string}`;
  if (data && data !== "0x") {
    try {
      const d = decodeFunctionData({ abi: erc20Abi, data });
      if (d.functionName === "transfer") {
        const [to, amt] = d.args as readonly [string, bigint];
        return { token: u.to, token_amount_base_units: amt.toString(), contract: u.to, recipient: to };
      }
      if (d.functionName === "transferFrom") {
        const [, to, amt] = d.args as readonly [string, string, bigint];
        return { token: u.to, token_amount_base_units: amt.toString(), contract: u.to, recipient: to };
      }
      if (d.functionName === "approve") {
        const [, amt] = d.args as readonly [string, bigint];
        return { token: u.to, token_amount_base_units: amt.toString(), contract: u.to };
      }
    } catch {
      /* not an ERC-20 call */
    }
    if (u.value !== "0") return { token: NATIVE_SYMBOL[chain], token_amount_base_units: u.value, contract: u.to };
    return { contract: u.to };
  }
  return { token: NATIVE_SYMBOL[chain], token_amount_base_units: u.value, recipient: u.to };
}

