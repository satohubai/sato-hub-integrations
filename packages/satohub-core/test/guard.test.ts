/** withSatoCheck + the payment-attempt record + checkTarget/checkInstall, all on mocked fetches. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AttemptUnresolvedError,
  JsonFileAttemptStore,
  SatoCheckRefusedError,
  SatoHubClient,
  withSatoCheck,
  type FetchLike,
} from "../src/index.js";

const terms = { x402Version: 1, accepts: [{ payTo: "0xabc", maxAmountRequired: "1000" }] };
const r402 = (body: unknown = terms) => new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json" } });

function checker(egress: "observed" | "not_observed" | "unknown", calls: string[] = []) {
  return {
    calls,
    async checkTarget(target: string) {
      calls.push(target);
      return {
        data: { summary: { key_egress: egress }, profile: { key_egress_hosts: ["evil.example"] }, check_url: "https://satohub.ai/check/x402/x" } as never,
        signature: { state: "unsigned", reason: "" } as const,
      };
    },
  };
}

test("first contact is checked once per host per 24 h", async () => {
  const c = checker("not_observed");
  const f = withSatoCheck(async () => r402(), { client: c, onWarning: () => {} });
  await f("https://pay.example/a");
  await f("https://pay.example/b");
  assert.equal(c.calls.length, 1);
});

test("warn mode passes the 402 through on observed egress", async () => {
  const warnings: string[] = [];
  const f = withSatoCheck(async () => r402(), { client: checker("observed"), onWarning: (m) => warnings.push(m) });
  assert.equal((await f("https://pay.example/a")).status, 402);
  assert.match(warnings[0]!, /observed leaving/);
});

test("enforce mode refuses on observed egress and on missing terms", async () => {
  const f = withSatoCheck(async () => r402(), { client: checker("observed"), mode: "enforce" });
  await assert.rejects(f("https://pay.example/a"), SatoCheckRefusedError);
  const g = withSatoCheck(async () => r402({}), { client: checker("not_observed"), mode: "enforce" });
  await assert.rejects(g("https://other.example/a"), SatoCheckRefusedError);
});

test("an unreadable check fails open with a warning", async () => {
  const warnings: string[] = [];
  const client = { checkTarget: async () => { throw new Error("down"); } };
  const f = withSatoCheck(async () => r402(), { client, mode: "enforce", onWarning: (m) => warnings.push(m) });
  assert.equal((await f("https://pay.example/a")).status, 402);
  assert.match(warnings[0]!, /could not read/);
});

test("a lost paid response leaves the attempt unknown and blocks a repeat until resolved", async () => {
  let fail = true;
  const inner: FetchLike = async (_u, init) => {
    const h = init?.headers as Record<string, string> | undefined;
    if (!h?.["X-PAYMENT"]) return r402();
    if (fail) throw new Error("socket hang up");
    return new Response("ok", { status: 200 });
  };
  const f = withSatoCheck(inner, { client: checker("not_observed"), onWarning: () => {} });
  const url = "https://pay.example/a";
  await f(url);
  const paid = { method: "POST", body: "{}", headers: { "X-PAYMENT": "sig" } };
  await assert.rejects(f(url, paid), /socket hang up/);
  await assert.rejects(f(url, paid), AttemptUnresolvedError);
  const key = await f.attemptKey({ method: "POST", url, body: "{}", payTo: "0xabc", amount: "1000" });
  await f.resolveAttempt(key, "failed");
  fail = false;
  assert.equal((await f(url, paid)).status, 200);
});

test("JsonFileAttemptStore survives a new wrapper (durable)", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sato-")), "attempts.json");
  const inner: FetchLike = async () => { throw new Error("timeout"); };
  const paid = { method: "POST", body: "x", headers: { "payment-signature": "s" } };
  await assert.rejects(withSatoCheck(inner, { attempts: new JsonFileAttemptStore(file) })("https://p.example", paid));
  await assert.rejects(withSatoCheck(inner, { attempts: new JsonFileAttemptStore(file) })("https://p.example", paid), AttemptUnresolvedError);
});

test("checkTarget GETs /api/check; checkInstall POSTs the command or config", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ schema: "sato.custody/v1", subjects: [] }), { status: 200 });
  };
  const c = new SatoHubClient({ fetch, verify: false });
  await c.checkTarget("npm:viem", "package");
  assert.equal(seen[0]!.url, "https://satohub.ai/api/check?target=npm%3Aviem&kind=package");
  await c.checkInstall("npm i viem");
  assert.equal(seen[1]!.url, "https://satohub.ai/api/check/install");
  assert.deepEqual(JSON.parse(String(seen[1]!.init?.body)), { command: "npm i viem" });
  await c.checkInstall('{"mcpServers":{}}');
  assert.deepEqual(JSON.parse(String(seen[2]!.init?.body)), { config: '{"mcpServers":{}}' });
});
