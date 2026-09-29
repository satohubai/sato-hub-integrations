// ADAPTERS. satoKitLangChainTools(kit, opts) → LangChain JS (@langchain/core)
// structured tools generated from the one tool surface (toolDefinitions). No
// per-action glue: each tool is a DynamicStructuredTool whose `schema` is the
// surface's JSON Schema (LangChain validates JSON Schema input itself) and
// whose func goes through the shared dispatcher. The func returns the envelope
// as a JSON string, the content a LangChain ToolMessage carries.
//
// LangChain has no native approval step. So, as in the AgentKit adapter:
//   - execute is REFUSED unless the tools were built with
//     { approve: async (summary) => boolean } and that callback returns true;
//   - other tools that need a person (prepare tools that would sign, pay or
//     broadcast) also go through `approve` when one is given.
// Each such tool's description says it requires approval.
import { DynamicStructuredTool } from "@langchain/core/tools";
import { approvalSummary, kitSurface, requiresApproval } from "./_dispatch.js";
import type { AdapterOptions, KitSurface, ToolEnvelope } from "./_dispatch.js";
import type { Kit } from "../types.js";

export type SatoKitLangChainApprove = (summary: string, call: { tool: string; args: unknown }) => Promise<boolean>;

export type SatoKitLangChainToolsOptions = AdapterOptions & { approve?: SatoKitLangChainApprove };

export type SatoKitLangChainTool = DynamicStructuredTool & { readonly sato_tool: string };

const APPROVAL_NOTE = " Requires a person's approval for each call: the tool asks its approve callback and refuses without one.";

/** Runs one tool with the approval gate; returns the envelope. Shared by every tool in one set. */
export function langChainRunner(surface: KitSurface, approve: SatoKitLangChainApprove | undefined) {
  return async function run(name: string, args: unknown): Promise<ToolEnvelope> {
    const def = surface.get(name);
    if (def && requiresApproval(def)) {
      if (!approve) {
        if (def.kind === "execute") {
          return { ok: false, tool: name, error: { code: "approval_required", message: `${name} needs a person's approval; build the tools with satoKitLangChainTools(kit, { approve }) to allow it` } };
        }
      } else {
        const ok = await approve(approvalSummary(def, args), { tool: name, args });
        if (!ok) return { ok: false, tool: name, error: { code: "approval_denied", message: `${name} was not approved` } };
      }
    }
    return surface.call(name, args);
  };
}

export function satoKitLangChainTools(kit: Kit, opts: SatoKitLangChainToolsOptions = {}): SatoKitLangChainTool[] {
  const surface = kitSurface(kit, opts);
  const run = langChainRunner(surface, opts.approve);
  return surface.defs.map((def) => {
    const schema = { ...(def.inputSchema as Record<string, unknown>), type: "object" } as any;
    const t = new DynamicStructuredTool({
      name: def.name,
      description: requiresApproval(def) ? def.description + APPROVAL_NOTE : def.description,
      schema,
      func: async (input: unknown) => JSON.stringify(await run(def.name, input)),
    }) as SatoKitLangChainTool;
    Object.defineProperty(t, "sato_tool", { value: def.name, enumerable: false });
    return t;
  });
}
