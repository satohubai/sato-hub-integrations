// ADAPTERS. createSatoKitSdkServer(kit) → an in-process Claude Agent SDK MCP
// server (createSdkMcpServer + tool()) generated from the one tool surface.
// requireApprovalHook() → a PreToolUse hook that answers "ask" for every tool
// whose effects need a person (execute, and prepare tools that would sign, pay
// or broadcast), so the SDK asks before the call runs.
//
// Input schemas are the surface's JSON Schemas turned into zod with the kit's
// own zod (z.fromJSONSchema), passed as a full object schema rather than a raw
// shape: a raw shape would strip unknown keys, and execute must REJECT an extra
// argument, not silently drop it. The dispatcher checks again either way.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, HookJSONOutput, McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SERVER_INSTRUCTIONS, toolDefinitions } from "../surface/index.js";
import type { ToolDef } from "../surface/index.js";
import { coreActions } from "../actions/registry.js";
import { KIT_VERSION } from "../version.js";
import { kitSurface, requiresApproval } from "./_dispatch.js";
import type { AdapterOptions, ToolEnvelope } from "./_dispatch.js";
import type { AnyAction, Kit } from "../types.js";

export const SATO_KIT_SERVER_NAME = "sato-kit";

export type SatoKitSdkServerOptions = AdapterOptions & { name?: string };

type CallToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function toResult(env: ToolEnvelope): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(env) }],
    structuredContent: env as unknown as Record<string, unknown>,
    ...(env.ok ? {} : { isError: true }),
  };
}

function zodInput(def: ToolDef): unknown {
  return z.fromJSONSchema(def.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
}

/** The tool definitions the server registers; exported so a test can call a handler directly. */
export function satoKitSdkTools(kit: Kit, opts: SatoKitSdkServerOptions = {}): SdkMcpToolDefinition<any>[] {
  const surface = kitSurface(kit, opts);
  return surface.defs.map((def) => {
    const t = tool(
      def.name,
      def.description,
      zodInput(def) as any,
      async (args: unknown) => toResult(await surface.call(def.name, args)) as any,
      { annotations: { title: def.title, ...def.annotations } },
    );
    return { ...t, _meta: { ...def._meta } };
  });
}

export function createSatoKitSdkServer(kit: Kit, opts: SatoKitSdkServerOptions = {}): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: opts.name ?? SATO_KIT_SERVER_NAME,
    version: KIT_VERSION,
    instructions: SERVER_INSTRUCTIONS,
    tools: satoKitSdkTools(kit, opts),
  });
}

export type RequireApprovalHookOptions = {
  /** The name the server was registered under in `mcpServers`. Default "sato-kit". */
  serverName?: string;
  /** The actions behind the server. Default coreActions(). */
  actions?: readonly AnyAction[];
};

/** The set of full host tool names (mcp__<server>__<tool>) that need a person's approval. */
export function approvalToolNames(opts: RequireApprovalHookOptions = {}): Set<string> {
  const server = opts.serverName ?? SATO_KIT_SERVER_NAME;
  const defs = toolDefinitions({ actions: opts.actions ?? coreActions(), toolsets: "all" });
  return new Set(defs.filter(requiresApproval).map((d) => `mcp__${server}__${d.name}`));
}

/**
 * A PreToolUse hook: "ask" for tools that need approval, nothing otherwise.
 * Register it as hooks: { PreToolUse: [{ matcher: "^mcp__sato-kit__", hooks: [requireApprovalHook()] }] }.
 * In a headless session the SDK refuses an "ask" rather than running the tool.
 */
export function requireApprovalHook(opts: RequireApprovalHookOptions = {}): HookCallback {
  const names = approvalToolNames(opts);
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse" || !names.has(input.tool_name)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `${input.tool_name} signs, pays or broadcasts; a person approves each call.`,
      },
    };
  };
}
