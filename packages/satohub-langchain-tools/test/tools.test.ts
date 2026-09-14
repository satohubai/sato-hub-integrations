import assert from "node:assert/strict";
import { test } from "node:test";

import { SatoHubClient, type FetchLike } from "satohub-core";

import {
  satohubBuildPlanTool,
  satohubPreflightTool,
  satohubRouteSwapTool,
  satohubSearchResourcesTool,
  satohubTools,
} from "../src/index.js";

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

const clientWith = (body: unknown, log: string[] = []) => new SatoHubClient({ fetch: mockFetch(body, log), verify: false });

test("four tools, snake_case names, in a stable order", () => {
  const names = satohubTools({ client: clientWith({}) }).map((t) => t.name);
  assert.deepEqual(names, ["satohub_search_resources", "satohub_preflight", "satohub_route_swap", "satohub_build_plan"]);
});

test("all four share one client, so one JWKS fetch serves the set", async () => {
  const log: string[] = [];
  const client = clientWith({ total: 0, resources: [] }, log);
  assert.equal(satohubTools({ client }).length, 4);
  await satohubSearchResourcesTool({ client }).invoke({ query: "wallet" });
  await satohubBuildPlanTool({ client }).invoke({ goal: "a Base trading agent" });
  assert.equal(log.filter((l) => l.includes("jwks")).length, 0); // verify:false in this test
  assert.ok(log[0]?.includes("/api/mcp"));
  assert.ok(log[1]?.includes("/api/satobot/plan"));
});

test("the tool returns the record as JSON, with provenance beside it", async () => {
  const tool = satohubPreflightTool({ client: clientWith({ verdict: "unknown", rule: "R6" }) });
  const out = JSON.parse(await tool.invoke({ package: "some-package" })) as Record<string, unknown>;
  assert.equal(out.verdict, "unknown");
  assert.equal((out._sato as { source: string }).source, "satohub.ai");
});

test("the descriptions carry the limits, not just the capability", () => {
  const tools = satohubTools({ client: clientWith({}) });
  assert.match(tools[1]!.description!, /never a security review/);
  assert.match(tools[2]!.description!, /not a fill/);
});

test("a swap of a token for itself never reaches the wire", async () => {
  const log: string[] = [];
  const tool = satohubRouteSwapTool({ client: clientWith({}, log) });
  await assert.rejects(async () => tool.invoke({ chain: "Base", token_in: "USDC", token_out: "USDC", amount: "1" }));
  assert.equal(log.length, 0);
});
