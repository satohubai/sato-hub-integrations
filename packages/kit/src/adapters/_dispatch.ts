// ADAPTERS. The one dispatcher every host adapter (AI SDK, AgentKit, Claude
// Agent SDK) calls. It takes the tool list from toolDefinitions() — never a
// second list — and turns a (tool name, args) call into a kit call, returning
// one envelope shape:
//
//   { ok: true,  tool, result }
//   { ok: false, tool, error: { code, message, refusals? }, intent? }
//
// There is no per-action glue here: a tool's `kind` (read / prepare / execute /
// meta) decides which kit method runs. A new registered action becomes a tool
// in every host with no edit to this file.
//
// The policy is a PRE-FLIGHT that explains refusals; the signer enforces.
// Approval is the host's job (needsApproval, a PreToolUse hook, or AgentKit's
// `approve` callback); `requiresApproval(def)` is the single test all three use.
import { ACTIONS_STATUS_URL, buildStatus, resolveTool, toolDefinitions } from "../surface/index.js";
import type { ToolDef, Toolsets } from "../surface/index.js";
import { coreActions } from "../actions/registry.js";
import { approvalHints } from "../spec/index.js";
import type { PreparedIntent, Refusal, SatoPolicy } from "../spec/index.js";
import type { AnyAction, Kit } from "../types.js";

export type AdapterOptions = {
  toolsets?: Toolsets;
  /** The actions the kit was created with. Defaults to coreActions(); pass the same list you gave createKit. */
  actions?: readonly AnyAction[];
  /** The policy the kit runs; needed only by the `status` tool (the Kit object does not expose it). */
  policy?: SatoPolicy;
  /** Signer kind for `status`, or null for none. */
  signerKind?: string | null;
  /** Used by `status` to read Sato Status (actions-status.json). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Timeout for that read, in ms. Default 3000. */
  statusTimeoutMs?: number;
};

export type ErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "policy_refused"
  | "approval_required"
  | "approval_denied"
  | "not_configured"
  | "error";

export type ToolError = { code: ErrorCode; message: string; refusals?: Refusal[] };

export type ToolEnvelope =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error: ToolError; intent?: PreparedIntent };

export type KitSurface = {
  defs: ToolDef[];
  get(name: string): ToolDef | null;
  call(name: string, args: unknown): Promise<ToolEnvelope>;
};

/** True when a person must approve each call of this tool (from its effects, via the surface). */
export function requiresApproval(def: ToolDef): boolean {
  return def._meta["anthropic/requiresUserInteraction"] === true;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The shallow checks every host needs regardless of its own schema handling. */
export function checkInput(def: ToolDef, args: unknown): string | null {
  const a = args === undefined ? {} : args;
  if (!isObj(a)) return `${def.name} takes an object`;
  const schema = def.inputSchema as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
  const props = schema.properties ?? {};
  for (const k of schema.required ?? []) if (!(k in a)) return `${def.name}: missing required "${k}"`;
  if (schema.additionalProperties === false) {
    const extra = Object.keys(a).filter((k) => !(k in props));
    if (extra.length) {
      return `${def.name} takes only ${Object.keys(props).join(", ") || "no arguments"}; refused ${extra.map((k) => JSON.stringify(k)).join(", ")}`;
    }
  }
  return null;
}

function refusalText(r: readonly Refusal[]): string {
  return r.map((x) => `${x.rule} (limit ${x.limit}, observed ${x.observed})`).join("; ");
}

function errOf(tool: string, e: unknown): ToolEnvelope {
  const message = e instanceof Error ? e.message : String(e);
  const refusals = (e as { refusals?: unknown })?.refusals;
  if (Array.isArray(refusals) && refusals.length) {
    return { ok: false, tool, error: { code: "policy_refused", message, refusals: refusals as Refusal[] } };
  }
  const code: ErrorCode = /refused by the policy pre-flight/.test(message) ? "policy_refused" : /takes only|must be|takes an object|input/.test(message) ? "invalid_input" : "error";
  return { ok: false, tool, error: { code, message } };
}

async function readActionsStatus(opts: AdapterOptions): Promise<unknown | null> {
  const f = opts.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch : undefined);
  if (!f) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.statusTimeoutMs ?? 3000);
  try {
    const res = await f(ACTIONS_STATUS_URL, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Builds the tool list and the dispatcher for one kit. Pure apart from the calls it makes. */
export function kitSurface(kit: Kit, opts: AdapterOptions = {}): KitSurface {
  const defs = toolDefinitions({ actions: opts.actions ?? coreActions(), toolsets: opts.toolsets ?? "default" });
  const byName = new Map(defs.map((d) => [d.name, d]));

  async function call(name: string, args: unknown): Promise<ToolEnvelope> {
    const def = byName.get(name) ?? null;
    if (!def) return { ok: false, tool: name, error: { code: "unknown_tool", message: `no tool "${name}" in this profile` } };
    const bad = checkInput(def, args);
    if (bad) return { ok: false, tool: name, error: { code: "invalid_input", message: bad } };
    const input = (args ?? {}) as Record<string, unknown>;
    try {
      switch (def.kind) {
        case "read":
          return { ok: true, tool: name, result: await kit.read(def.oda_id!, input) };
        case "prepare": {
          const intent = await kit.prepare(def.oda_id!, input);
          if (!intent.policy.ok) {
            return {
              ok: false,
              tool: name,
              error: { code: "policy_refused", message: `refused by the policy pre-flight: ${refusalText(intent.policy.refusals)}`, refusals: [...intent.policy.refusals] },
              intent,
            };
          }
          return { ok: true, tool: name, result: intent };
        }
        case "execute":
          // Only { intent_id } reaches the kit; checkInput already refused anything else.
          return { ok: true, tool: name, result: await kit.execute({ intent_id: input.intent_id as string }) };
        case "meta":
          return await meta(def, input);
      }
    } catch (e) {
      return errOf(name, e);
    }
  }

  async function meta(def: ToolDef, input: Record<string, unknown>): Promise<ToolEnvelope> {
    const name = def.name;
    if (name === "actions_search") {
      const q = typeof input.query === "string" ? input.query : "";
      const results = kit.search(q).map((d) => ({ id: d.id, name: d.name, title: d.title, effects: [...d.effects] }));
      return { ok: true, tool: name, result: { results } };
    }
    if (name === "actions_describe") {
      const target = resolveTool(toolDefinitions({ actions: opts.actions ?? coreActions(), toolsets: "all" }), String(input.action ?? ""));
      if (!target || !target.oda_id) {
        return { ok: false, tool: name, error: { code: "invalid_input", message: `no action "${String(input.action)}"` } };
      }
      const descriptor = kit.describe(target.oda_id);
      return { ok: true, tool: name, result: { descriptor, approval_hints: approvalHints(descriptor.effects) } };
    }
    if (name === "status") {
      if (!opts.policy) {
        return { ok: false, tool: name, error: { code: "not_configured", message: "status needs the kit's policy; pass { policy } to the adapter" } };
      }
      const actionsStatus = await readActionsStatus(opts);
      return { ok: true, tool: name, result: buildStatus({ policy: opts.policy, tools: defs, signerKind: opts.signerKind ?? null, actionsStatus }) };
    }
    return { ok: false, tool: name, error: { code: "unknown_tool", message: `no handler for meta tool "${name}"` } };
  }

  return { defs, get: (n) => byName.get(n) ?? null, call };
}

/** One line a person can read before approving a call. No amounts are invented: it quotes the args. */
export function approvalSummary(def: ToolDef, args: unknown): string {
  const effects = def._meta["sato/effects"].join(", ");
  return `${def.title} (${def.name}; effects: ${effects}) with ${JSON.stringify(args ?? {})}`;
}
