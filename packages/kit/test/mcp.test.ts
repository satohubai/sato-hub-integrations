import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_TOOL_NAMES, SERVER_INSTRUCTIONS, coreActions, createKit } from "../src/index.js";
import { createKitMcpServer, textMirror, TEXT_MIRROR_MAX_CHARS } from "../src/mcp/server.js";
import type { AnyAction, PrepareAction } from "../src/types.js";
import { SECRET, T0, okSim, policy, rpc, sendAction } from "./kit-fixtures.js";

const core = coreActions();
const swapDesc = core.find((a) => a.descriptor.id === "swap.prepare")!.descriptor;
// swap.prepare's descriptor, with an offline build (1 USD trade).
const fakeSwap: PrepareAction = { descriptor: swapDesc, build: ((input: { sell_amount: string }, ctx) => sendAction.build({ amount: input.sell_amount }, ctx)) as PrepareAction["build"] };
const actions: AnyAction[] = core.map((a) => (a.descriptor.id === "swap.prepare" ? fakeSwap : a));
const capped = { ...policy, max_usd_per_trade: 0.5 };

async function connect(toolsets?: "default" | "all") {
  const kit = createKit({ policy: capped, actions, rpc, secret: SECRET, clock: () => T0, simulate: async () => okSim });
  const offline = (async () => { throw new Error("offline"); }) as typeof fetch;
  const server = createKitMcpServer(kit, { toolsets, actions, policy: capped, fetch: offline });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, server };
}

test("tools/list default profile = the eight names, each with outputSchema + annotations", async () => {
  const { client, server } = await connect();
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), [...DEFAULT_TOOL_NAMES]);
  for (const t of tools) {
    assert.ok(t.outputSchema, t.name);
    assert.ok(t.annotations && typeof t.annotations.readOnlyHint === "boolean", t.name);
  }
  const ex = tools.find((t) => t.name === "execute")!;
  assert.equal(ex.annotations!.destructiveHint, true);
  assert.equal(ex._meta?.["anthropic/requiresUserInteraction"], true);
  assert.equal(ex.inputSchema.additionalProperties, false);
  const q = tools.find((t) => t.name === "swap_quote")!;
  assert.equal(q.annotations!.readOnlyHint, true);
  assert.equal(q.annotations!.idempotentHint, true);
  await client.close(); await server.close();
});

test("--toolsets all adds erc8004_lookup and tx_simulate", async () => {
  const { client, server } = await connect("all");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), [...DEFAULT_TOOL_NAMES, "erc8004_lookup", "tx_simulate", "token_approvals_list", "token_approvals_revoke", "erc8004_register", "bridge_quote", "bridge_prepare", "safe_info", "safe_propose", "solana_read", "solana_transfer", "solana_swap_quote", "solana_swap_prepare"]);
  await client.close(); await server.close();
});

test("execute with an extra argument fails validation", async () => {
  const { client, server } = await connect();
  const r = await client.callTool({ name: "execute", arguments: { intent_id: "x", amount: "5" } });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /invalid arguments for execute/);
  await client.close(); await server.close();
});

test("prepare over the cap is a normal result carrying the refusals", async () => {
  const { client, server } = await connect();
  const r = await client.callTool({ name: "swap_prepare", arguments: { chain: "base", sell_token: "USDC", buy_token: "WETH", sell_amount: "1000", taker: "0x0000000000000000000000000000000000000001" } });
  assert.notEqual(r.isError, true);
  const sc = r.structuredContent as { intent_id: string; policy: { ok: boolean; refusals: Array<{ rule: string }> } };
  assert.equal(sc.policy.ok, false);
  assert.ok(sc.policy.refusals.some((x) => x.rule === "max_usd_per_trade"), JSON.stringify(sc.policy));
  // and execute on it is refused, naming the rule
  const e = await client.callTool({ name: "execute", arguments: { intent_id: sc.intent_id } });
  assert.equal(e.isError, true);
  assert.match(JSON.stringify(e.content), /max_usd_per_trade/);
  await client.close(); await server.close();
});

test("status with an unreachable status file reports unknown, never a guess", async () => {
  const { client, server } = await connect();
  const r = await client.callTool({ name: "status", arguments: {} });
  const sc = r.structuredContent as { status_source: string; tools: Array<{ result: string }> };
  assert.equal(sc.status_source, "unreachable");
  assert.ok(sc.tools.every((t) => t.result === "unknown"));
  const d = await client.callTool({ name: "actions_describe", arguments: { action: "swap.prepare" } });
  assert.equal((d.structuredContent as { descriptor: { id: string } }).descriptor.id, "swap.prepare");
  const s = await client.callTool({ name: "actions_search", arguments: { query: "swap" } });
  assert.ok((s.structuredContent as { results: unknown[] }).results.length > 0);
  await client.close(); await server.close();
});

test("text mirror is capped with a note", () => {
  const t = textMirror("h", { big: "x".repeat(TEXT_MIRROR_MAX_CHARS * 2) });
  assert.ok(t.length <= TEXT_MIRROR_MAX_CHARS);
  assert.match(t, /truncated/);
});

test("a stdio spawn answers initialize (2025-11-25) + tools/list in under 10 s", { timeout: 20_000 }, async () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const entry = resolve(here, "../src/mcp/index.js");
  const cwd = mkdtempSync(join(tmpdir(), "sato-kit-mcp-"));
  const script = `import(${JSON.stringify(entry)}).then(m => m.runStdio({ cwd: ${JSON.stringify(cwd)}, env: {}, fetch: async () => { throw new Error("offline"); } }))`;
  const t0 = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    let buf = "";
    const waitFor = (id: number) => new Promise<Record<string, unknown>>((res, rej) => {
      const onData = (c: Buffer) => {
        buf += c.toString();
        for (const line of buf.split("\n")) {
          if (!line.trim()) continue;
          try { const m = JSON.parse(line); if (m.id === id) { child.stdout.off("data", onData); res(m); return; } } catch { /* partial */ }
        }
      };
      child.stdout.on("data", onData);
      child.once("exit", (c) => rej(new Error(`server exited ${c}`)));
    });
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    const init = await waitFor(1);
    assert.equal((init.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await waitFor(2);
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.deepEqual(names, [...DEFAULT_TOOL_NAMES]);
    assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
  } finally {
    child.kill("SIGKILL");
  }
});
