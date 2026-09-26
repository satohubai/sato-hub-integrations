import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SatoHubClient, type FetchLike } from "satohub-core";

import { DEFAULT_USER_AGENT, satohubTools } from "../src/index.js";

function mockFetch(body: unknown, log: string[] = []): FetchLike {
  return async (url, init) => {
    log.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("jwks")) return new Response('{"keys":[]}', { status: 200 });
    if (url.includes("/api/mcp")) {
      return new Response(`event: message\ndata: ${JSON.stringify({ result: { structuredContent: body } })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const toolsWith = (body: unknown, log: string[] = []) =>
  satohubTools({ client: new SatoHubClient({ fetch: mockFetch(body, log), verify: false }) });

test("exactly four tools, under the names the model sees", () => {
  assert.deepEqual(Object.keys(toolsWith({})), [
    "satohub_search_resources",
    "satohub_preflight",
    "satohub_route_swap",
    "satohub_build_plan",
  ]);
});

test("every description names what the reading is not", () => {
  const tools = toolsWith({});
  assert.match(tools.satohub_search_resources.description!, /not a security review/);
  assert.match(tools.satohub_preflight.description!, /`unknown` means Sato Hub holds no record/);
  assert.match(tools.satohub_route_swap.description!, /NON-CUSTODIAL/);
  assert.match(tools.satohub_build_plan.description!, /Nothing in a plan is invented/);
});

test("the payload comes back verbatim, with provenance beside it and not inside it", async () => {
  const payload = { verdict: "go", rule: "R5", evidence: [{ check: "Directory record" }] };
  const tools = toolsWith(payload);
  const out = (await tools.satohub_preflight.execute!({ repo: "coinbase/agentkit" }, {} as never)) as Record<string, unknown>;
  assert.equal(out.verdict, "go");
  assert.deepEqual(out.evidence, payload.evidence);
  const meta = out._sato as { signature: { state: string }; source: string; citation_ask: string };
  assert.equal(meta.source, "satohub.ai");
  assert.match(meta.citation_ask, /cite its sato_url/);
  assert.equal(meta.signature.state, "skipped");
});

test("search goes to the MCP endpoint; the acting tools go to their REST routes", async () => {
  const log: string[] = [];
  const tools = toolsWith({ total: 0, resources: [] }, log);
  await tools.satohub_search_resources.execute!({ query: "wallet" }, {} as never);
  await tools.satohub_build_plan.execute!({ goal: "a Base trading agent" }, {} as never);
  assert.ok(log[0]?.startsWith("POST https://satohub.ai/api/mcp"));
  assert.ok(log[1]?.startsWith("GET https://satohub.ai/api/satobot/plan"));
});

test("the swap schema demands an integer string, so a decimal never reaches the wire", () => {
  const schema = toolsWith({}).satohub_route_swap.inputSchema as {
    safeParse: (v: unknown) => { success: boolean };
  };
  assert.equal(schema.safeParse({ chain: "Base", token_in: "USDC", token_out: "WETH", amount: "1000000" }).success, true);
  assert.equal(schema.safeParse({ chain: "Base", token_in: "USDC", token_out: "WETH", amount: 1.5 }).success, false);
  assert.equal(schema.safeParse({ chain: "Base", token_in: "USDC", token_out: "WETH" }).success, false);
});

test("a swap of a token for itself is refused before any request is made", async () => {
  const log: string[] = [];
  const tools = toolsWith({}, log);
  await assert.rejects(
    async () => tools.satohub_route_swap.execute!({ chain: "Base", token_in: "USDC", token_out: "usdc", amount: "1" }, {} as never),
    /must differ/,
  );
  assert.equal(log.length, 0);
});

// ── the user-agent ─────────────────────────────────────────────────────────

test("the default user-agent is this package's name and version, never `SatoHub-…`", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  assert.equal(DEFAULT_USER_AGENT, `satohub-ai-sdk-tools/${pkg.version}`, "bump DEFAULT_USER_AGENT with package.json");
  // Sato Hub counts `SatoHub-<name>` user-agents as its own scripts.
  assert.doesNotMatch(DEFAULT_USER_AGENT, /^SatoHub-/);
});
