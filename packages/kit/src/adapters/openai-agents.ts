// ADAPTERS. satoKitOpenAITools(kit, opts) → OpenAI Agents SDK (JS,
// @openai/agents) function tools generated from the one tool surface
// (toolDefinitions). No per-action glue: each tool is tool({ name,
// description, parameters: <surface JSON Schema>, strict: false, execute })
// and execute goes through the shared dispatcher.
//
// Names come from the surface (odaIdToToolName already maps "swap.prepare" to
// "swap_prepare"), so they match ^[a-zA-Z0-9_-]{1,64}$ as OpenAI requires; the
// constructor asserts it rather than trusting it.
//
// Approval: every tool whose effects need a person (execute, and prepare tools
// that would sign, pay or broadcast) sets the SDK's `needsApproval: true`. The
// runner then stops with an interruption and never calls execute until the
// program approves that call (result.state.approve / reject).
//
// strict: false because the surface schemas carry optional properties; the
// dispatcher's checkInput still refuses unknown or missing arguments.
import { tool } from "@openai/agents";
import type { FunctionTool } from "@openai/agents";
import { kitSurface, requiresApproval } from "./_dispatch.js";
import type { AdapterOptions, ToolEnvelope } from "./_dispatch.js";
import type { Kit } from "../types.js";

export type SatoKitOpenAIToolsOptions = AdapterOptions;
export type SatoKitOpenAITool = FunctionTool<unknown, any, ToolEnvelope>;

const OPENAI_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function satoKitOpenAITools(kit: Kit, opts: SatoKitOpenAIToolsOptions = {}): SatoKitOpenAITool[] {
  const surface = kitSurface(kit, opts);
  return surface.defs.map((def) => {
    if (!OPENAI_TOOL_NAME.test(def.name)) throw new Error(`satoKitOpenAITools: ${JSON.stringify(def.name)} is not a valid OpenAI tool name`);
    const schema = { ...(def.inputSchema as Record<string, unknown>), type: "object" } as any;
    return tool({
      name: def.name,
      description: def.description,
      parameters: schema,
      strict: false,
      needsApproval: requiresApproval(def),
      execute: async (input: unknown) => surface.call(def.name, input),
    }) as unknown as SatoKitOpenAITool;
  });
}
