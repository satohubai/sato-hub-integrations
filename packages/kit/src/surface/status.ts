// SKELETON (M1). Pure builder for the `status` meta tool, shared by every door.
// The fetch of actions-status.json is the door's job (inject fetch, time out,
// treat any failure as unreachable); this turns what it got into the output.
import type { PolicyNetwork, SatoPolicy } from "../spec/index.js";
import { KIT_VERSION } from "../version.js";
import type { ToolDef } from "./tools.js";

export type ToolStatusResult = "green" | "red" | "error" | "not_listed" | "unknown";

export type StatusOutput = {
  kit_version: string;
  network: PolicyNetwork;
  signer: string;
  policy: {
    allow_chains: string[];
    allow_venues: string[];
    max_usd_per_trade?: number;
    max_usd_per_day?: number;
    max_slippage_bps?: number;
    intent_ttl_s: number;
    unknown_verdict: "refuse" | "allow";
    human_approval: boolean;
  };
  status_source: "reachable" | "unreachable";
  tools: Array<{ name: string; result: ToolStatusResult; last_green?: string; failing_step?: string; upstream_version?: string }>;
};

type ActionStatusEntry = {
  id?: unknown;
  name?: unknown;
  result?: unknown;
  last_green?: unknown;
  failing_step?: unknown;
  upstream_version?: unknown;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Finds a tool's row in sato.action-status/v1: by id "<kind>:<oda id or tool name>", else by name. Only sato-kit rows count. */
function findEntry(entries: readonly ActionStatusEntry[], def: ToolDef): ActionStatusEntry | undefined {
  const keys = new Set([def.name, ...(def.oda_id ? [def.oda_id] : [])]);
  return entries.find((e) => typeof e.id === "string" && e.id.startsWith("sato-kit:") && keys.has(e.id.slice("sato-kit:".length)))
    ?? entries.find((e) => typeof e.id === "string" && e.id.startsWith("sato-kit:") && typeof e.name === "string" && keys.has(e.name));
}

/**
 * `actionsStatus` is the parsed actions-status.json, or null when it could not
 * be read. Unreachable → every tool "unknown", never a guessed result.
 */
export function buildStatus(input: {
  policy: SatoPolicy;
  tools: readonly ToolDef[];
  signerKind: string | null;
  actionsStatus: unknown | null;
}): StatusOutput {
  const p = input.policy;
  const policy: StatusOutput["policy"] = {
    allow_chains: [...p.allow_chains],
    allow_venues: [...p.allow_venues],
    intent_ttl_s: p.intent_ttl_s,
    unknown_verdict: p.unknown_verdict,
    human_approval: p.human_approval,
  };
  if (p.max_usd_per_trade !== null) policy.max_usd_per_trade = p.max_usd_per_trade;
  if (p.max_usd_per_day !== null) policy.max_usd_per_day = p.max_usd_per_day;
  if (p.max_slippage_bps !== null) policy.max_slippage_bps = p.max_slippage_bps;

  const doc = input.actionsStatus as { schema?: unknown; actions?: unknown } | null;
  const reachable = !!doc && doc.schema === "sato.action-status/v1" && Array.isArray(doc.actions);
  const entries = reachable ? (doc!.actions as ActionStatusEntry[]).filter((e) => typeof e === "object" && e !== null) : [];

  const tools = input.tools.map((def) => {
    if (!reachable) return { name: def.name, result: "unknown" as const };
    const e = findEntry(entries, def);
    if (!e) return { name: def.name, result: "not_listed" as const };
    const result: ToolStatusResult = e.result === "green" || e.result === "red" || e.result === "error" ? e.result : "unknown";
    const row: StatusOutput["tools"][number] = { name: def.name, result };
    const lg = str(e.last_green);
    if (lg && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(lg)) row.last_green = lg;
    if (result === "red") {
      const fs = str(e.failing_step);
      const uv = str(e.upstream_version);
      if (fs) row.failing_step = fs;
      if (uv) row.upstream_version = uv;
    }
    return row;
  });

  return {
    kit_version: KIT_VERSION,
    network: p.network,
    signer: input.signerKind ?? "none",
    policy,
    status_source: reachable ? "reachable" : "unreachable",
    tools,
  };
}
