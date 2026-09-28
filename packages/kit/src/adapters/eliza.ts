// ADAPTERS. satoKitElizaPlugin(kit, opts) → an elizaOS (@elizaos/core 1.x)
// Plugin whose `actions` are the same tools as every other door, generated from
// the one tool surface. No per-action glue.
//
// COMPATIBILITY SHIM ONLY. No Sato template depends on elizaOS; our own
// persona-agent template covers that use case. This subpath exists so an
// existing elizaOS agent can call the kit. It is thin by design and will be
// dropped, not patched around, if an elizaOS release breaks it.
//
// Arguments: elizaOS 1.x actions receive no structured arguments, so the
// handler reads them from `options.parameters`, then `message.content.parameters`,
// else {}. Action names are the surface names upper-cased with a SATO_KIT_
// prefix (elizaOS convention); `sato_tool` on each action carries the surface name.
//
// elizaOS has no approval hook. So, like /agentkit: execute is REFUSED unless
// the plugin was built with { approve: async (summary) => boolean } and it
// returns true; other tools that need a person also go through `approve` when
// one is given.
//
// Types: @elizaos/core 1.x ships extensionless re-exports that NodeNext
// resolution cannot follow, so the Action / ActionResult / Plugin shapes are
// declared here structurally (copied from its types/components.d.ts and
// types/plugin.d.ts) and nothing is imported from it at runtime or compile
// time. The test checks the plugin with elizaOS's own validatePlugin.
import { approvalSummary, kitSurface, requiresApproval } from "./_dispatch.js";
import type { AdapterOptions, KitSurface, ToolEnvelope } from "./_dispatch.js";
import type { Kit } from "../types.js";

/** elizaOS 1.x ActionResult. */
export type ActionResult = { text?: string; values?: Record<string, unknown>; data?: Record<string, unknown>; success: boolean; error?: string | Error };
/** elizaOS 1.x HandlerCallback (Content → Memory[]). */
export type HandlerCallback = (response: { text?: string; actions?: string[]; [key: string]: unknown }) => Promise<unknown[]>;
/** elizaOS 1.x Action, structurally. runtime/message/state stay opaque. */
export type Action = {
  name: string;
  description: string;
  similes?: string[];
  examples?: unknown[][];
  validate: (runtime: unknown, message: unknown, state?: unknown) => Promise<boolean>;
  handler: (runtime: unknown, message: any, state?: unknown, options?: { parameters?: unknown; [key: string]: unknown }, callback?: HandlerCallback, responses?: unknown[]) => Promise<ActionResult | void | undefined>;
  [key: string]: unknown;
};
/** The subset of an elizaOS 1.x Plugin this adapter fills. */
export type Plugin = { name: string; description: string; actions?: Action[]; [key: string]: unknown };

export type SatoKitElizaApprove = (summary: string, call: { tool: string; args: unknown }) => Promise<boolean>;
export type SatoKitElizaOptions = AdapterOptions & { approve?: SatoKitElizaApprove };
export type SatoKitElizaAction = Action & { sato_tool: string };
export type SatoKitElizaPlugin = Plugin & { actions: SatoKitElizaAction[]; run: (name: string, args: unknown) => Promise<ToolEnvelope> };

const APPROVAL_NOTE = " Requires a person's approval for each call: the plugin asks its approve callback and refuses without one.";

export function elizaActionName(toolName: string): string {
  return `SATO_KIT_${toolName.toUpperCase()}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Runs one tool with the approval gate; returns the envelope. */
async function gated(surface: KitSurface, approve: SatoKitElizaApprove | undefined, name: string, args: unknown): Promise<ToolEnvelope> {
  const def = surface.get(name);
  if (def && requiresApproval(def)) {
    if (!approve) {
      if (def.kind === "execute") {
        return { ok: false, tool: name, error: { code: "approval_required", message: `${name} needs a person's approval; build satoKitElizaPlugin(kit, { approve }) to allow it` } };
      }
    } else if (!(await approve(approvalSummary(def, args), { tool: name, args }))) {
      return { ok: false, tool: name, error: { code: "approval_denied", message: `${name} was not approved` } };
    }
  }
  return surface.call(name, args);
}

export function satoKitElizaPlugin(kit: Kit, opts: SatoKitElizaOptions = {}): SatoKitElizaPlugin {
  const surface = kitSurface(kit, opts);
  const run = (name: string, args: unknown) => gated(surface, opts.approve, name, args);
  const actions: SatoKitElizaAction[] = surface.defs.map((def) => ({
    name: elizaActionName(def.name),
    sato_tool: def.name,
    similes: [def.name],
    description: requiresApproval(def) ? def.description + APPROVAL_NOTE : def.description,
    validate: async () => true,
    handler: async (_runtime, message, _state, options, callback): Promise<ActionResult> => {
      const content = isObj(message?.content) ? (message.content as Record<string, unknown>) : {};
      const args = options?.parameters ?? content.parameters ?? {};
      const env = await run(def.name, args);
      const text = JSON.stringify(env);
      if (callback) await callback({ text, actions: [elizaActionName(def.name)] });
      return env.ok
        ? { success: true, text, data: { envelope: env } }
        : { success: false, text, error: env.error.message, data: { envelope: env } };
    },
  }));
  return { name: "sato-kit", description: "Sato Kit: prepare -> execute for onchain agent actions (compatibility adapter).", actions, run };
}
