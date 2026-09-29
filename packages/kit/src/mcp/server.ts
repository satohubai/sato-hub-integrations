// The kit's local MCP server. Its tools are exactly toolDefinitions({ actions,
// toolsets }) — the ONE tool surface — with SERVER_INSTRUCTIONS.
//
// - read tools      → kit.read
// - prepare tools   → kit.prepare. A refused intent (policy.ok false) is a
//                     normal result: the refusals are in structuredContent.
// - execute         → kit.execute({ intent_id }) and nothing else.
// - status / actions_search / actions_describe → meta handlers here.
//
// Every result carries structuredContent (verification data lives there) and a
// text mirror capped at TEXT_MIRROR_MAX_CHARS (~5K tokens), truncated with a note.
// runStdio is the ONLY path that attaches a signer: the server is never served
// over HTTP from this package.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ActionDescriptor, OdaEffect, SatoPolicy } from "../spec/index.js";
import { POLICY_SCHEMA_ID, approvalHints, parsePolicyFile } from "../spec/index.js";
import type { AnyAction, Kit, KitFetch } from "../types.js";
import {
  readActionsStatusDoc,
  type StatusFetch,
  SERVER_INSTRUCTIONS,
  buildStatus,
  resolveTool,
  toolDefinitions,
} from "../surface/index.js";
import type { ToolDef, Toolsets } from "../surface/index.js";
import { loadKitFromEnv } from "../config/index.js";
import type { LoadKitOptions } from "../config/index.js";
import { kitUserAgent, KIT_VERSION } from "../version.js";

export const SERVER_NAME = "sato-kit";
/** ~5K tokens at ~4 characters per token. */
export const TEXT_MIRROR_MAX_CHARS = 20_000;
export const STATUS_FETCH_TIMEOUT_MS = 5_000;

export type KitMcpServerOptions = {
  toolsets?: Toolsets;
  /** The actions the kit was built with. Without them the tools are derived from kit.search(""). */
  actions?: readonly AnyAction[];
  /** The policy in force (for status). Default: the default policy. */
  policy?: SatoPolicy;
  /** Signer kind for status, or null for none. */
  signerKind?: string | null;
  /** Fetch for actions-status.json. Default globalThis.fetch. */
  fetch?: KitFetch;
  /** Overrides ACTIONS_STATUS_URL (tests). */
  actionsStatusUrl?: string;
};
export type RunStdioOptions = LoadKitOptions & { toolsets?: Toolsets };

const PASSIVE: readonly OdaEffect[] = ["read", "quote", "simulate"];

/** Stand-ins for actions known only by descriptor: prepare iff any effect is not passive. */
function actionsFromKit(kit: Kit): AnyAction[] {
  return kit.search("").map((d: ActionDescriptor) => {
    const passive = d.effects.length > 0 && d.effects.every((e) => PASSIVE.includes(e));
    return (passive
      ? { descriptor: d, run: async () => { throw new Error("stand-in"); } }
      : { descriptor: d, build: async () => { throw new Error("stand-in"); } }) as unknown as AnyAction;
  });
}

function defaultPolicy(): SatoPolicy {
  const p = parsePolicyFile({ schema: POLICY_SCHEMA_ID });
  if (!p.ok) throw new Error(p.error);
  return p.policy;
}

export function textMirror(header: string, value: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(value, null, 2) ?? "null";
  } catch {
    body = String(value);
  }
  const full = `${header}\n${body}`;
  if (full.length <= TEXT_MIRROR_MAX_CHARS) return full;
  const note = "\n… [truncated: the text mirror is capped; the complete result is in structuredContent]";
  return full.slice(0, TEXT_MIRROR_MAX_CHARS - note.length) + note;
}

function ok(header: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: textMirror(header, structured) }], structuredContent: structured };
}

/** Meta key for a failed call's machine-readable detail (error message, refusals). */
export const ERROR_META_KEY = "ai.satohub/error";

// A failed call carries no structuredContent: clients validate structuredContent
// against the tool's outputSchema even when isError is set. The detail goes in
// _meta (and the text mirror) instead.
function fail(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [{ type: "text", text: textMirror(`Error: ${message}`, extra) }], _meta: { [ERROR_META_KEY]: { error: message, ...extra } } };
}

async function fetchActionsStatus(f: KitFetch, url: string | undefined): Promise<unknown | null> {
  // An explicit URL (tests) is read alone; the default reads the status branch
  // with the 404-only fallback to the frozen main copy.
  const r = await readActionsStatusDoc(f as unknown as StatusFetch, {
    timeoutMs: STATUS_FETCH_TIMEOUT_MS,
    headers: { "user-agent": kitUserAgent() },
    ...(url ? { primaryUrl: url, fallbackUrl: null } : {}),
  });
  return r.doc;
}

function toMcpTool(d: ToolDef): Tool {
  return {
    name: d.name,
    title: d.title,
    description: d.description,
    inputSchema: d.inputSchema as Tool["inputSchema"],
    outputSchema: d.outputSchema as Tool["outputSchema"],
    annotations: { title: d.title, ...d.annotations, openWorldHint: d.kind !== "meta" },
    _meta: { ...d._meta },
  };
}

export function createKitMcpServer(kit: Kit, opts: KitMcpServerOptions = {}): Server {
  const actions = opts.actions ?? actionsFromKit(kit);
  const defs = toolDefinitions({ actions, toolsets: opts.toolsets ?? "default" });
  const byName = new Map(defs.map((d) => [d.name, d]));
  const policy = opts.policy ?? defaultPolicy();
  const fetchImpl: KitFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const statusUrl = opts.actionsStatusUrl;

  const validator = new AjvJsonSchemaValidator();
  const inputValidators = new Map<string, (v: unknown) => { valid: boolean; errorMessage?: string }>();
  function validateInput(d: ToolDef, args: unknown): string | null {
    let v = inputValidators.get(d.name);
    if (!v) {
      try {
        const compiled = validator.getValidator(d.inputSchema as never);
        v = (x: unknown) => compiled(x);
      } catch (e) {
        return `input schema for ${d.name} could not be compiled: ${(e as Error).message}`;
      }
      inputValidators.set(d.name, v);
    }
    const r = v(args);
    return r.valid ? null : r.errorMessage ?? "input does not match the schema";
  }

  const server = new Server(
    { name: SERVER_NAME, version: KIT_VERSION, title: "Sato Kit" },
    { capabilities: { tools: { listChanged: false } }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: defs.map(toMcpTool) }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const d = byName.get(req.params.name);
    if (!d) return fail(`unknown tool "${req.params.name}"`);
    const args = req.params.arguments ?? {};
    const invalid = validateInput(d, args);
    if (invalid) return fail(`invalid arguments for ${d.name}: ${invalid}`);
    try {
      switch (d.kind) {
        case "read": {
          const out = await kit.read(d.oda_id!, args);
          const structured = (out && typeof out === "object" && !Array.isArray(out) ? out : { result: out }) as Record<string, unknown>;
          return ok(`${d.name}: result`, structured);
        }
        case "prepare": {
          const intent = await kit.prepare(d.oda_id!, args);
          const head = intent.policy.ok
            ? `${d.name}: prepared intent ${intent.intent_id} (expires ${intent.expires_at}). ${intent.summary}`
            : `${d.name}: refused by the policy pre-flight — ${intent.policy.refusals.map((r) => r.rule).join(", ")}. ${intent.summary}`;
          return ok(head, intent as unknown as Record<string, unknown>);
        }
        case "execute": {
          const { intent_id } = args as { intent_id: string };
          const receipt = await kit.execute({ intent_id });
          return ok(`execute: ${receipt.status}${receipt.tx_hash ? ` ${receipt.tx_hash}` : ""}`, receipt as unknown as Record<string, unknown>);
        }
        case "meta":
          return await meta(d.name, args as Record<string, unknown>);
      }
    } catch (e) {
      const refusals = (e as { refusals?: unknown }).refusals;
      return fail(e instanceof Error ? e.message : String(e), Array.isArray(refusals) ? { refusals } : {});
    }
  });

  async function meta(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name === "status") {
      const doc = await fetchActionsStatus(fetchImpl, statusUrl);
      const s = buildStatus({ policy, tools: defs, signerKind: opts.signerKind ?? null, actionsStatus: doc });
      return ok(`status: kit ${s.kit_version}, network ${s.network}, signer ${s.signer}, Sato Status ${s.status_source}`, s as unknown as Record<string, unknown>);
    }
    if (name === "actions_search") {
      const q = typeof args.query === "string" ? args.query : "";
      const results = kit.search(q).map((x) => ({ id: x.id, name: x.name, title: x.title, effects: [...x.effects] }));
      return ok(`actions_search: ${results.map((r) => r.name).join(", ") || "no match"}`, { results });
    }
    if (name === "actions_describe") {
      const want = String(args.action);
      const def = resolveTool(defs, want);
      const id = def?.oda_id ?? kit.search("").find((x) => x.id === want || x.name === want)?.id;
      if (!id) return fail(`no action "${want}"`);
      const descriptor = kit.describe(id);
      return ok(`actions_describe: ${descriptor.id} — ${descriptor.title}`, { descriptor, approval_hints: approvalHints(descriptor.effects) });
    }
    return fail(`unknown meta tool "${name}"`);
  }

  return server;
}

/** Builds the kit from cwd/env and serves it over stdio. The only signer path. */
export async function runStdio(opts: RunStdioOptions): Promise<void> {
  const loaded = await loadKitFromEnv(opts);
  const server = createKitMcpServer(loaded.kit, {
    toolsets: opts.toolsets,
    actions: loaded.actions,
    policy: loaded.policy,
    signerKind: loaded.signer?.kind ?? null,
    fetch: opts.fetch,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    // The SDK transport does not end when stdin closes; the host closing stdin ends the session.
    process.stdin.once("end", () => { void server.close(); });
    process.stdin.once("close", () => { void server.close(); });
  });
}
