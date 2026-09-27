// ADAPTERS. satoKitTools(kit, opts) → an AI SDK ToolSet generated from the one
// tool surface (toolDefinitions). Each tool: jsonSchema(inputSchema) input, an
// execute that goes through the shared dispatcher, and — for every tool whose
// effects need a person (execute, and prepare tools that would sign, pay or
// broadcast) — the AI SDK approval flag `needsApproval: true`.
//
// ai@7 marks the tool-level `needsApproval` as deprecated in favour of a
// generateText/streamText-level `toolApproval`; it is still honoured. For hosts
// on the newer path, satoKitToolApproval(tools) returns the matching
// `toolApproval` configuration ("user-approval" for the same tools).
import { jsonSchema, tool } from "ai";
import type { Tool } from "ai";
import { kitSurface, requiresApproval } from "./_dispatch.js";
import type { AdapterOptions, ToolEnvelope } from "./_dispatch.js";
import type { Kit } from "../types.js";
import type { Toolsets } from "../surface/index.js";

export type SatoKitToolsOptions = AdapterOptions & { toolsets?: Toolsets };
export type SatoKitAiTools = Record<string, Tool<Record<string, unknown>, ToolEnvelope>>;

export function satoKitTools(kit: Kit, opts: SatoKitToolsOptions = {}): SatoKitAiTools {
  const surface = kitSurface(kit, opts);
  const out: SatoKitAiTools = {};
  for (const def of surface.defs) {
    const approval = requiresApproval(def);
    out[def.name] = tool<Record<string, unknown>, ToolEnvelope, any>({
      title: def.title,
      description: def.description,
      inputSchema: jsonSchema<Record<string, unknown>>(def.inputSchema as any),
      ...(approval ? { needsApproval: true } : {}),
      metadata: { source: "sato-kit", kind: def.kind, effects: def._meta["sato/effects"] },
      execute: (input: Record<string, unknown>) => surface.call(def.name, input),
    });
  }
  return out;
}

/** The generateText/streamText `toolApproval` config for these tools: "user-approval" where a person must approve. */
export function satoKitToolApproval(tools: SatoKitAiTools): Record<string, "user-approval"> {
  const out: Record<string, "user-approval"> = {};
  for (const [name, t] of Object.entries(tools)) if ((t as { needsApproval?: unknown }).needsApproval === true) out[name] = "user-approval";
  return out;
}
