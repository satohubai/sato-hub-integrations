// The conformance table (test/conformance) run through the five host
// subpaths and the kit's local MCP server (six doors).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { satoKitTools } from "../src/adapters/ai-sdk.js";
import { satoKitActionProvider } from "../src/adapters/agentkit.js";
import { satoKitOpenAITools } from "../src/adapters/openai-agents.js";
import { satoKitElizaPlugin } from "../src/adapters/eliza.js";
import { RunContext } from "@openai/agents";
import { createKitMcpServer } from "../src/mcp/index.js";
import { CORE_ACTIONS } from "../src/index.js";
import { createSatoKitSdkServer, requireApprovalHook } from "../src/adapters/claude-agent-sdk.js";
import assert from "node:assert/strict";
import type { ToolEnvelope } from "../src/adapters/_dispatch.js";
import { runConformance } from "./conformance/index.js";
import type { ConformanceRunner } from "./conformance/index.js";

const WALLET = {} as any; // the Sato Kit actions use the kit's own signer, never AgentKit's wallet provider

export const aiSdkRunner: ConformanceRunner = {
  name: "ai-sdk",
  async create(kit, policy) {
    const tools = satoKitTools(kit, { policy });
    const opts = { toolCallId: "t1", messages: [] } as any;
    return {
      async listTools() { return Object.keys(tools); },
      async call(name, args) { return (await (tools[name]!.execute as any)(args, opts)) as ToolEnvelope; },
      async approvalRequired(name, args) {
        const na = (tools[name] as { needsApproval?: unknown }).needsApproval;
        return typeof na === "function" ? !!(await na(args, opts)) : na === true;
      },
      // The AI SDK does not call execute for a needsApproval tool until the approval
      // response arrives (asserted end to end in adapters-ai-sdk.test.ts).
      async callUnapproved() { return null; },
    };
  },
};

export const agentKitRunner: ConformanceRunner = {
  name: "agentkit",
  async create(kit, policy) {
    const approved = satoKitActionProvider(kit, { policy, approve: async () => true });
    const bare = satoKitActionProvider(kit, { policy });
    const actions = approved.getActions(WALLET);
    const bareActions = bare.getActions(WALLET);
    const invoke = async (list: typeof actions, name: string, args: unknown): Promise<ToolEnvelope> => {
      const a = list.find((x) => x.name === name);
      if (!a) return { ok: false, tool: name, error: { code: "unknown_tool", message: name } };
      const parsed = (a.schema as any).safeParse(args); // what AgentKit's framework extensions do before invoke
      if (!parsed.success) return { ok: false, tool: name, error: { code: "invalid_input", message: String(parsed.error) } };
      return JSON.parse(await a.invoke(parsed.data));
    };
    return {
      async listTools() { return actions.map((a) => a.name); },
      call: (name, args) => invoke(actions, name, args),
      async approvalRequired(name, args) {
        let asked = false;
        const probe = satoKitActionProvider(kit, { policy, approve: async () => { asked = true; return false; } });
        const env = await probe.run(name, args);
        return asked && !env.ok && env.error.code === "approval_denied";
      },
      callUnapproved: (name, args) => invoke(bareActions, name, args),
    };
  },
};

export const claudeAgentSdkRunner: ConformanceRunner = {
  name: "claude-agent-sdk",
  async create(kit, policy) {
    const server = createSatoKitSdkServer(kit, { policy });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "satohub-conformance", version: "0.0.0" });
    await (server.instance as any).connect(a);
    await client.connect(b);
    const hook = requireApprovalHook();
    return {
      async listTools() { return (await client.listTools()).tools.map((t) => t.name); },
      async call(name, args) {
        const res: any = await client.callTool({ name, arguments: args as Record<string, unknown> });
        if (res.structuredContent) return res.structuredContent as ToolEnvelope;
        // Rejected by the server's own input validation before the handler ran.
        const text = (res.content ?? []).map((c: any) => c.text ?? "").join(" ");
        return { ok: false, tool: name, error: { code: res.isError && /validation|invalid|unrecognized/i.test(text) ? "invalid_input" : "error", message: text } };
      },
      async approvalRequired(name, args) {
        const out: any = await hook(
          { hook_event_name: "PreToolUse", tool_name: `mcp__sato-kit__${name}`, tool_input: args, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "" } as any,
          "t1",
          { signal: new AbortController().signal },
        );
        return out?.hookSpecificOutput?.permissionDecision === "ask";
      },
      // The SDK stops the call at "ask" when no person approves; the tool never runs.
      async callUnapproved() { return null; },
      async close() { await client.close(); },
    };
  },
};

export const openAIAgentsRunner: ConformanceRunner = {
  name: "openai-agents",
  async create(kit, policy) {
    const tools = satoKitOpenAITools(kit, { policy });
    const ctx = new RunContext({});
    const find = (name: string) => tools.find((t) => t.name === name);
    return {
      async listTools() { return tools.map((t) => t.name); },
      async call(name, args) {
        const t = find(name);
        if (!t) return { ok: false, tool: name, error: { code: "unknown_tool", message: name } };
        // What the runner does once a call is approved: invoke with the model's JSON arguments.
        const out: unknown = await t.invoke(ctx, JSON.stringify(args ?? {}), { toolCall: { type: "function_call", callId: "c1", name, arguments: JSON.stringify(args ?? {}) } } as any);
        return (typeof out === "string" ? JSON.parse(out) : out) as ToolEnvelope;
      },
      async approvalRequired(name, args) {
        const t = find(name);
        return !!t && (await t.needsApproval(ctx, args as any, "c1"));
      },
      // The Agents SDK runner returns an interruption for a needsApproval tool and never
      // invokes it until result.state.approve() is called.
      async callUnapproved() { return null; },
    };
  },
};

export const elizaRunner: ConformanceRunner = {
  name: "eliza",
  async create(kit, policy) {
    const approved = satoKitElizaPlugin(kit, { policy, approve: async () => true });
    const bare = satoKitElizaPlugin(kit, { policy });
    const eliza: any = await import("@elizaos/core"); // elizaOS's own plugin check
    assert.deepEqual(eliza.validatePlugin(approved), { isValid: true, errors: [] });
    const invoke = async (plugin: typeof approved, name: string, args: unknown): Promise<ToolEnvelope> => {
      const a = plugin.actions.find((x) => x.sato_tool === name);
      if (!a) return { ok: false, tool: name, error: { code: "unknown_tool", message: name } };
      const msg = { content: { text: "" } } as any;
      assert.equal(await a.validate({} as any, msg), true);
      const res: any = await a.handler({} as any, msg, undefined, { parameters: args } as any);
      return res.data.envelope as ToolEnvelope;
    };
    return {
      async listTools() { return approved.actions.map((a) => String(a.sato_tool)); },
      call: (name, args) => invoke(approved, name, args),
      async approvalRequired(name, args) {
        let asked = false;
        const probe = satoKitElizaPlugin(kit, { policy, approve: async () => { asked = true; return false; } });
        const env = await probe.run(name, args);
        return asked && !env.ok && env.error.code === "approval_denied";
      },
      callUnapproved: (name, args) => invoke(bare, name, args),
    };
  },
};

// The MCP server speaks MCP results, not the adapter envelope, so this runner
// maps them: a prepare the pre-flight refused is a normal MCP result carrying
// policy.refusals (the host sees rule/limit/observed in structuredContent) and
// maps to policy_refused; a schema rejection maps to invalid_input.
function mcpEnvelope(name: string, res: any): ToolEnvelope {
  const sc = res.structuredContent as Record<string, any> | undefined;
  if (res.isError) {
    const sc = res._meta?.["ai.satohub/error"] as Record<string, any> | undefined;
    const message = String(sc?.error ?? (res.content ?? []).map((c: any) => c.text ?? "").join(" "));
    if (Array.isArray(sc?.refusals) && sc!.refusals.length) return { ok: false, tool: name, error: { code: "policy_refused", message, refusals: sc!.refusals } };
    return { ok: false, tool: name, error: { code: /^invalid arguments/.test(message) ? "invalid_input" : "error", message } };
  }
  if (sc && sc.policy && sc.policy.ok === false) {
    return { ok: false, tool: name, error: { code: "policy_refused", message: "refused by the policy pre-flight", refusals: sc.policy.refusals }, intent: sc as any };
  }
  return { ok: true, tool: name, result: sc };
}

export const mcpRunner: ConformanceRunner = {
  name: "mcp",
  async create(kit, policy) {
    const offline = (async () => { throw new Error("offline"); }) as typeof fetch;
    const server = createKitMcpServer(kit, { actions: CORE_ACTIONS.list(), policy, fetch: offline });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "satohub-conformance", version: "0.0.0" });
    await server.connect(a);
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    return {
      async listTools() { return tools.map((t) => t.name); },
      async call(name, args) { return mcpEnvelope(name, await client.callTool({ name, arguments: args as Record<string, unknown> })); },
      async approvalRequired(name) {
        const t = tools.find((x) => x.name === name);
        return !!t && t._meta?.["anthropic/requiresUserInteraction"] === true && t.annotations?.destructiveHint === true;
      },
      // An MCP host that honours requiresUserInteraction does not send tools/call until a person approves.
      async callUnapproved() { return null; },
      async close() { await client.close(); await server.close(); },
    };
  },
};

runConformance(mcpRunner);
runConformance(aiSdkRunner);
runConformance(agentKitRunner);
runConformance(claudeAgentSdkRunner);
runConformance(openAIAgentsRunner);
runConformance(elizaRunner);
