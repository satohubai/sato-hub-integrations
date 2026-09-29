import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS_STATUS_FALLBACK_URL, ACTIONS_STATUS_URL, readActionsStatusDoc } from "../src/surface/index.js";

const DOC = { schema: "sato.action-status/v1", actions: [] };
function fake(answers: Record<string, number | "throw">) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const a = answers[url];
    if (a === "throw" || a === undefined) throw new TypeError("fetch failed");
    return { ok: a === 200, status: a, json: async () => ({ ...DOC, from: url }) };
  };
  return { f, calls };
}

test("URLs: status branch first, frozen main copy as fallback", () => {
  assert.match(ACTIONS_STATUS_URL, /sato-agent-templates\/status\/actions-status\.json$/);
  assert.match(ACTIONS_STATUS_FALLBACK_URL, /sato-agent-templates\/main\/actions-status\.json$/);
});

test("status branch answers: main is never read", async () => {
  const { f, calls } = fake({ [ACTIONS_STATUS_URL]: 200, [ACTIONS_STATUS_FALLBACK_URL]: 200 });
  const r = await readActionsStatusDoc(f, { timeoutMs: 1000 });
  assert.equal(r.source, "status-branch");
  assert.equal(r.url, ACTIONS_STATUS_URL);
  assert.deepEqual(calls, [ACTIONS_STATUS_URL]);
});

test("status branch 404: falls back to main and says so", async () => {
  const { f, calls } = fake({ [ACTIONS_STATUS_URL]: 404, [ACTIONS_STATUS_FALLBACK_URL]: 200 });
  const r = await readActionsStatusDoc(f, { timeoutMs: 1000 });
  assert.equal(r.source, "main-fallback");
  assert.equal(r.url, ACTIONS_STATUS_FALLBACK_URL);
  assert.equal((r.doc as { from: string }).from, ACTIONS_STATUS_FALLBACK_URL);
  assert.deepEqual(calls, [ACTIONS_STATUS_URL, ACTIONS_STATUS_FALLBACK_URL]);
});

test("status branch 500: no silent fallback to main", async () => {
  const { f, calls } = fake({ [ACTIONS_STATUS_URL]: 500, [ACTIONS_STATUS_FALLBACK_URL]: 200 });
  const r = await readActionsStatusDoc(f, { timeoutMs: 1000 });
  assert.equal(r.doc, null);
  assert.equal(r.source, null);
  assert.match(r.reason ?? "", /HTTP 500/);
  assert.deepEqual(calls, [ACTIONS_STATUS_URL]);
});

test("status branch unreachable: no silent fallback to main", async () => {
  const { f, calls } = fake({ [ACTIONS_STATUS_URL]: "throw", [ACTIONS_STATUS_FALLBACK_URL]: 200 });
  const r = await readActionsStatusDoc(f, { timeoutMs: 1000 });
  assert.equal(r.doc, null);
  assert.deepEqual(calls, [ACTIONS_STATUS_URL]);
});

test("404 then fallback fails: unreachable, reason names both", async () => {
  const { f } = fake({ [ACTIONS_STATUS_URL]: 404, [ACTIONS_STATUS_FALLBACK_URL]: 503 });
  const r = await readActionsStatusDoc(f, { timeoutMs: 1000 });
  assert.equal(r.doc, null);
  assert.match(r.reason ?? "", /404.*HTTP 503/);
});
