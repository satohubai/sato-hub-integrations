// Host-specific checks the shared conformance table does not cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ACTIONS_STATUS_URL, DEFAULT_TOOL_NAMES, SERVER_INSTRUCTIONS, coreActions, toolDefinitions } from "../src/index.js";
import { satoKitToolApproval, satoKitTools } from "../src/adapters/ai-sdk.js";
import { satoKitActionProvider } from "../src/adapters/agentkit.js";
import { approvalToolNames, createSatoKitSdkServer, requireApprovalHook } from "../src/adapters/claude-agent-sdk.js";
import { kitSurface, requiresApproval } from "../src/adapters/_dispatch.js";
import { fixtureKit } from "./conformance/fixture-kit.js";

const ALL = toolDefinitions({ actions: coreActions(), toolsets: "all" });
const WRITE = ALL.filter(requiresApproval).map((d) => d.name).sort();

test("approval set comes from the surface: execute plus the prepare tools that sign, pay or broadcast", () => {
  assert.deepEqual(WRITE, ["bridge_prepare", "erc8004_register", "execute", "swap_prepare", "token_approvals_revoke", "x402_prepare"]);
});

test("ai-sdk: toolsets all adds the two extra tools; needsApproval only on write tools; toolApproval mirrors it", async () => {
  const { kit, policy } = await fixtureKit();
  const tools = satoKitTools(kit, { policy, toolsets: "all" });
  assert.deepEqual(Object.keys(tools), ALL.map((d) => d.name));
  for (const [name, t] of Object.entries(tools)) {
    assert.equal((t as any).needsApproval === true, WRITE.includes(name), name);
    assert.ok((t as any).description.length > 0);
  }
  assert.deepEqual(Object.keys(satoKitToolApproval(tools)).sort(), WRITE);
});

test("ai-sdk: generateText stops at an approval request and never runs execute", async () => {
  const fk = await fixtureKit();
  const prep: any = await kitSurface(fk.kit, { policy: fk.policy }).call("swap_prepare", fk.swapInput);
  const tools = satoKitTools(fk.kit, { policy: fk.policy });
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "execute", input: JSON.stringify({ intent_id: prep.result.intent_id }) }],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    } as any,
  });
  const res: any = await generateText({ model, tools, prompt: "run it" });
  const parts = res.content ?? [];
  assert.ok(parts.some((p: any) => p.type === "tool-approval-request"), JSON.stringify(parts.map((p: any) => p.type)));
  assert.ok(!parts.some((p: any) => p.type === "tool-result"), "no tool result without approval");
  assert.equal(fk.sent.length, 0);
});

test("agentkit: supportsNetwork is base and base-sepolia only; write actions say they need approval", async () => {
  const { kit, policy } = await fixtureKit();
  const p = satoKitActionProvider(kit, { policy });
  assert.equal(p.supportsNetwork({ protocolFamily: "evm", networkId: "base-mainnet" }), true);
  assert.equal(p.supportsNetwork({ protocolFamily: "evm", networkId: "base-sepolia" }), true);
  assert.equal(p.supportsNetwork({ protocolFamily: "evm", chainId: "8453" }), true);
  assert.equal(p.supportsNetwork({ protocolFamily: "evm", networkId: "ethereum-mainnet" }), false);
  assert.equal(p.supportsNetwork({ protocolFamily: "svm", networkId: "solana-mainnet" }), false);
  const actions = p.getActions({} as any);
  assert.deepEqual(actions.map((a) => a.name), [...DEFAULT_TOOL_NAMES]);
  for (const a of actions) assert.equal(/Requires a person's approval/.test(a.description), WRITE.includes(a.name), a.name);
});

test("agentkit: approve receives a readable summary and a false answer stops the call", async () => {
  const fk = await fixtureKit();
  const seen: string[] = [];
  const p = satoKitActionProvider(fk.kit, { policy: fk.policy, approve: async (s) => { seen.push(s); return false; } });
  const env = await p.run("swap_prepare", fk.swapInput);
  assert.equal(env.ok, false);
  assert.match(seen[0]!, /swap_prepare; effects: quote, sign, broadcast/);
});

test("claude-agent-sdk: server lists tools with annotations and _meta, carries the instructions, and the hook asks only for write tools", async () => {
  const { kit, policy } = await fixtureKit();
  const server = createSatoKitSdkServer(kit, { policy, toolsets: "all" });
  assert.equal(server.type, "sdk");
  assert.equal(server.name, "sato-kit");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "satohub-test", version: "0.0.0" });
  await (server.instance as any).connect(a);
  await client.connect(b);
  try {
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    const listed = (await client.listTools()).tools;
    assert.deepEqual(listed.map((t) => t.name), ALL.map((d) => d.name));
    for (const t of listed) {
      const def = ALL.find((d) => d.name === t.name)!;
      assert.equal(t.annotations?.destructiveHint, def.annotations.destructiveHint, t.name);
      assert.equal(t.annotations?.readOnlyHint, def.annotations.readOnlyHint, t.name);
      assert.equal((t._meta as any)?.["anthropic/requiresUserInteraction"] === true, WRITE.includes(t.name), t.name);
    }
  } finally {
    await client.close();
  }
  assert.deepEqual([...approvalToolNames()].sort(), WRITE.map((n) => `mcp__sato-kit__${n}`));
  const hook = requireApprovalHook({ serverName: "wallet" });
  const ask: any = await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__wallet__execute", tool_input: {}, tool_use_id: "x" } as any, "x", { signal: new AbortController().signal });
  assert.equal(ask.hookSpecificOutput.permissionDecision, "ask");
  const pass: any = await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__wallet__chain_read", tool_input: {}, tool_use_id: "x" } as any, "x", { signal: new AbortController().signal });
  assert.deepEqual(pass, {});
});

test("status: reads Sato Status through the injected fetch; unreachable → every tool unknown; no policy → not_configured", async () => {
  const { kit, policy } = await fixtureKit();
  const doc = {
    schema: "sato.action-status/v1",
    updated: "2026-09-26",
    actions: [
      { id: "sato-kit:chain.read", name: "chain_read", result: "green", last_green: "2026-09-26" },
      { id: "sato-kit:swap.quote", name: "swap_quote", result: "red", failing_step: "quote", upstream_version: "1.2.3", last_green: "2026-09-20" },
    ],
  };
  const urls: string[] = [];
  const okFetch = (async (u: any) => { urls.push(String(u)); return new Response(JSON.stringify(doc), { status: 200 }); }) as typeof fetch;
  const env: any = await kitSurface(kit, { policy, fetch: okFetch, signerKind: "viem-local" }).call("status", {});
  assert.equal(env.ok, true);
  assert.deepEqual(urls, [ACTIONS_STATUS_URL]);
  assert.equal(env.result.status_source, "reachable");
  assert.equal(env.result.signer, "viem-local");
  const row = (n: string) => env.result.tools.find((t: any) => t.name === n);
  assert.equal(row("chain_read").result, "green");
  assert.deepEqual(row("swap_quote"), { name: "swap_quote", result: "red", last_green: "2026-09-20", failing_step: "quote", upstream_version: "1.2.3" });
  assert.equal(row("execute").result, "not_listed");

  const down = (async () => { throw new TypeError("offline"); }) as typeof fetch;
  const env2: any = await kitSurface(kit, { policy, fetch: down }).call("status", {});
  assert.equal(env2.result.status_source, "unreachable");
  assert.ok(env2.result.tools.every((t: any) => t.result === "unknown"));

  const env3: any = await kitSurface(kit, {}).call("status", {});
  assert.equal(env3.ok, false);
  assert.equal(env3.error.code, "not_configured");
});

test("actions_search and actions_describe accept an ODA id or a tool name", async () => {
  const { kit, policy } = await fixtureKit();
  const s = kitSurface(kit, { policy });
  const found: any = await s.call("actions_search", { query: "swap" });
  assert.deepEqual(found.result.results.map((r: any) => r.name).sort(), ["swap_prepare", "swap_quote"]);
  for (const q of ["swap.prepare", "swap_prepare"]) {
    const d: any = await s.call("actions_describe", { action: q });
    assert.equal(d.ok, true, q);
    assert.equal(d.result.descriptor.id, "swap.prepare");
    assert.equal(d.result.approval_hints.requiresUserInteraction, true);
  }
  const miss: any = await s.call("actions_describe", { action: "nope.nope" });
  assert.equal(miss.ok, false);
  const unknown: any = await s.call("erc8004_lookup", {});
  assert.equal(unknown.error.code, "unknown_tool", "not in the default profile");
});
