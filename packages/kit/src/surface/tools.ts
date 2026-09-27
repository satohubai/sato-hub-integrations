// SKELETON (M1). The ONE tool surface every door uses: the MCP server, the
// CLI, and the AI SDK / AgentKit / Claude Agent SDK adapters all derive their
// tools from toolDefinitions(). A second list anywhere else would let two
// doors disagree about what a tool is called, what it accepts, or whether it
// needs a person's approval — so there is no second list.
//
// Pure: no I/O, no clock. The handlers live with each door; this file only
// says what the tools ARE.
import {
  INTENT_ID_RE,
  ODA_CHAINS,
  POLICY_NETWORKS,
  RECEIPT_STATUSES,
  approvalHints,
  isOdaId,
  toolNameToOdaId,
} from "../spec/index.js";
import type { ActionDescriptor, JsonSchemaObject, OdaEffect } from "../spec/index.js";
import type { AnyAction } from "../types.js";

export type ToolKind = "read" | "prepare" | "execute" | "meta";
export type Toolsets = "default" | "all";

export type ToolAnnotations = {
  readOnlyHint: boolean;
  idempotentHint: boolean;
  destructiveHint: boolean;
};

export type ToolMeta = {
  /** Present (and true) only when a person must approve each call. */
  "anthropic/requiresUserInteraction"?: true;
  "sato/effects": OdaEffect[];
};

export type ToolDef = {
  /** snake_case, ≤40 characters; what every host sees. */
  name: string;
  /** The ODA id behind the tool; null for execute and the meta tools. */
  oda_id: string | null;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema: JsonSchemaObject;
  annotations: ToolAnnotations;
  _meta: ToolMeta;
  kind: ToolKind;
};

/** The default profile, in this exact order. */
export const DEFAULT_TOOL_NAMES = [
  "chain_read",
  "swap_quote",
  "swap_prepare",
  "x402_prepare",
  "execute",
  "status",
  "actions_search",
  "actions_describe",
] as const;

/** Tools that are not ODA actions; defined here, not by a descriptor. */
export const META_TOOL_NAMES = ["execute", "status", "actions_search", "actions_describe"] as const;
export type MetaToolName = (typeof META_TOOL_NAMES)[number];

/** Sato Status: the nightly per-action results (sato.action-status/v1). */
export const ACTIONS_STATUS_URL = "https://raw.githubusercontent.com/satohubai/sato-agent-templates/main/actions-status.json";

const DATE_SCHEMA = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } as const;

const REFUSALS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      rule: { type: "string" },
      limit: { type: "string" },
      observed: { type: "string" },
      message: { type: "string" },
    },
    required: ["rule", "limit", "observed", "message"],
  },
} as const;

const EXECUTE_EFFECTS: OdaEffect[] = ["sign", "broadcast"];
const META_EFFECTS: OdaEffect[] = ["read"];

function metaDefs(): Record<MetaToolName, Omit<ToolDef, "annotations" | "_meta" | "oda_id"> & { effects: OdaEffect[] }> {
  return {
    execute: {
      name: "execute",
      kind: "execute",
      effects: EXECUTE_EFFECTS,
      title: "Execute a prepared intent",
      description:
        "Signs and broadcasts one intent that a prepare tool returned, identified by its intent_id and nothing else. Use it after a person has read the intent summary, the simulation and the fee disclosure and approved that exact intent. Do not use it to change an amount, a recipient or a venue: prepare a new intent instead. It fails when the intent expired, was refused by the policy pre-flight, was already executed, or no signer is configured. Effect: moves funds on the chain named in the intent and appends a receipt to the local receipt log.",
      inputSchema: {
        type: "object",
        properties: {
          intent_id: { type: "string", pattern: INTENT_ID_RE.source, description: "The intent_id a prepare tool returned." },
        },
        required: ["intent_id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          schema: { type: "string", enum: ["sato.receipt/v1"] },
          seq: { type: "integer" },
          prev_hash: { type: "string" },
          hash: { type: "string" },
          intent_id: { type: "string", pattern: INTENT_ID_RE.source },
          action: { type: "string" },
          chain: { type: "string", enum: [...ODA_CHAINS] },
          params_digest: { type: "string" },
          policy: { type: "object", properties: { ok: { type: "boolean" }, refusals: REFUSALS_SCHEMA } },
          simulation: { description: "The simulation the intent was prepared with (object)." },
          fee_disclosure: { description: "The fee disclosure for the venue, quoted verbatim (object), or null when the action has none." },
          tx_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
          status: { type: "string", enum: [...RECEIPT_STATUSES] },
          created_at: { type: "string" },
          mandate: { type: "object" },
        },
        required: ["schema", "seq", "hash", "intent_id", "action", "status", "created_at"],
      },
    },
    status: {
      name: "status",
      kind: "meta",
      effects: META_EFFECTS,
      title: "Kit status",
      description:
        "Reports how this kit is configured: its version, the network mode (fork, testnet or mainnet), a summary of the policy pre-flight in force, whether a signer is configured, and for each available tool the date it last passed the nightly Sato Status checks when that record can be reached. Use it before a first prepare, or to explain why a call was refused. It reads local configuration and one public status file; it changes nothing.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: {
          kit_version: { type: "string" },
          network: { type: "string", enum: [...POLICY_NETWORKS] },
          signer: { type: "string", description: "Signer kind, or none." },
          policy: {
            type: "object",
            properties: {
              allow_chains: { type: "array", items: { type: "string" } },
              allow_venues: { type: "array", items: { type: "string" } },
              max_usd_per_trade: { type: "number" },
              max_usd_per_day: { type: "number" },
              max_slippage_bps: { type: "integer" },
              intent_ttl_s: { type: "integer" },
              unknown_verdict: { type: "string", enum: ["refuse", "allow"] },
              human_approval: { type: "boolean" },
            },
            required: ["allow_chains", "allow_venues", "intent_ttl_s", "unknown_verdict", "human_approval"],
          },
          status_source: { type: "string", enum: ["reachable", "unreachable"] },
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                result: { type: "string", enum: ["green", "red", "error", "not_listed", "unknown"] },
                last_green: DATE_SCHEMA,
                failing_step: { type: "string" },
                upstream_version: { type: "string" },
              },
              required: ["name", "result"],
            },
          },
        },
        required: ["kit_version", "network", "signer", "policy", "status_source", "tools"],
      },
    },
    actions_search: {
      name: "actions_search",
      kind: "meta",
      effects: META_EFFECTS,
      title: "Search actions",
      description:
        "Finds the actions this kit can run whose id or title contains the query text, and returns each one's id, tool name, title and effects. Use it to discover which tool fits a task before calling it. An empty query lists every registered action. It changes nothing.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 200, description: "Text to match against action ids and titles." } },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                title: { type: "string" },
                effects: { type: "array", items: { type: "string" } },
              },
              required: ["id", "name", "title", "effects"],
            },
          },
        },
        required: ["results"],
      },
    },
    actions_describe: {
      name: "actions_describe",
      kind: "meta",
      effects: META_EFFECTS,
      title: "Describe an action",
      description:
        "Returns the full sato.action/v1 descriptor for one action, given its id (swap.prepare) or its tool name (swap_prepare): effects, what it can do with a key and with money, the chains it supports, its input and output schemas, the pre-flight rules it runs and the exact upstream versions it wraps. Use it before calling an unfamiliar tool. It changes nothing.",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string", pattern: "^[a-z][a-z0-9._]{0,79}$", description: "An ODA id or a tool name." } },
        required: ["action"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          descriptor: { type: "object" },
          approval_hints: { type: "object" },
        },
        required: ["descriptor"],
      },
    },
  };
}

function hintsFor(effects: readonly OdaEffect[]): { annotations: ToolAnnotations; _meta: ToolMeta } {
  const h = approvalHints(effects);
  const _meta: ToolMeta = { "sato/effects": [...effects] };
  if (h.requiresUserInteraction) _meta["anthropic/requiresUserInteraction"] = true;
  return {
    annotations: { readOnlyHint: h.readOnlyHint, idempotentHint: h.idempotentHint, destructiveHint: h.destructiveHint },
    _meta,
  };
}

function isPrepare(a: AnyAction): boolean {
  return typeof (a as { build?: unknown }).build === "function";
}

function fromAction(a: AnyAction): ToolDef {
  const d: ActionDescriptor = a.descriptor;
  return {
    name: d.name,
    oda_id: d.id,
    title: d.title,
    description: d.description,
    inputSchema: d.input_schema,
    outputSchema: d.output_schema,
    ...hintsFor(d.effects),
    kind: isPrepare(a) ? "prepare" : "read",
  };
}

function fromMeta(name: MetaToolName): ToolDef {
  const { effects, ...rest } = metaDefs()[name];
  return { ...rest, oda_id: null, ...hintsFor(effects) };
}

/**
 * Every tool, in a fixed order. "default" is exactly DEFAULT_TOOL_NAMES
 * (a default name with no registered action is left out rather than
 * invented); "all" appends every other registered action in registry order.
 */
export function toolDefinitions(opts: { actions: readonly AnyAction[]; toolsets?: Toolsets }): ToolDef[] {
  const toolsets = opts.toolsets ?? "default";
  const byName = new Map<string, AnyAction>();
  for (const a of opts.actions) {
    if (byName.has(a.descriptor.name)) throw new Error(`duplicate tool name "${a.descriptor.name}"`);
    if ((META_TOOL_NAMES as readonly string[]).includes(a.descriptor.name)) {
      throw new Error(`action "${a.descriptor.id}" collides with the meta tool "${a.descriptor.name}"`);
    }
    byName.set(a.descriptor.name, a);
  }
  const out: ToolDef[] = [];
  for (const name of DEFAULT_TOOL_NAMES) {
    if ((META_TOOL_NAMES as readonly string[]).includes(name)) out.push(fromMeta(name as MetaToolName));
    else {
      const a = byName.get(name);
      if (a) out.push(fromAction(a));
    }
  }
  if (toolsets === "all") {
    for (const [name, a] of byName) if (!(DEFAULT_TOOL_NAMES as readonly string[]).includes(name)) out.push(fromAction(a));
  }
  return out;
}

/**
 * Resolves what a caller typed — an ODA id (swap.prepare) or a tool name
 * (swap_prepare) — to one ToolDef, or null. Meta tools resolve by name only.
 */
export function resolveTool(defs: readonly ToolDef[], nameOrId: string): ToolDef | null {
  if (typeof nameOrId !== "string") return null;
  const q = nameOrId.trim();
  if (isOdaId(q)) return defs.find((d) => d.oda_id === q) ?? null;
  const direct = defs.find((d) => d.name === q);
  if (direct) return direct;
  const known = defs.map((d) => d.oda_id).filter((x): x is string => x !== null);
  const id = toolNameToOdaId(q, known);
  return id ? defs.find((d) => d.oda_id === id) ?? null : null;
}
