// The conformance table (test/conformance) run through the three host
// subpaths. The MCP server is the fourth runner, wired at merge (see the TODO
// in test/conformance/index.ts).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { satoKitTools } from "../src/adapters/ai-sdk.js";
import { satoKitActionProvider } from "../src/adapters/agentkit.js";
import { createSatoKitSdkServer, requireApprovalHook } from "../src/adapters/claude-agent-sdk.js";
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

runConformance(aiSdkRunner);
runConformance(agentKitRunner);
runConformance(claudeAgentSdkRunner);
