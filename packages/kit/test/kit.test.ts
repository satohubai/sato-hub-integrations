import { test } from "node:test";
import assert from "node:assert/strict";
import { createKit } from "../src/kit.js";
import { memoryIntentStore } from "../src/intent/index.js";
import { memoryReceiptLog } from "../src/receipts/index.js";
import type { IntentRecord, IntentStore } from "../src/types.js";
import type { UnsignedEvmTx } from "../src/spec/index.js";
import { SECRET, T0, fakeEvaluator, fakeSigner, okSim, policy, readAction, rpc, sendAction } from "./kit-fixtures.js";

function setup(o: { refuseAll?: boolean; noSim?: boolean; store?: IntentStore } = {}) {
  const calls: string[] = [];
  const sent: UnsignedEvmTx[] = [];
  let now = T0;
  const receipts = memoryReceiptLog();
  const store = o.store ?? memoryIntentStore();
  const kit = createKit({
    policy, rpc, secret: SECRET, clock: () => now, actions: [sendAction, readAction], signer: fakeSigner(sent),
    intents: store, receipts, evaluate: fakeEvaluator(calls, o),
    simulate: async () => { calls.push("simulate"); if (o.noSim) throw new Error("fork unreachable"); return okSim; },
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  return { kit, calls, sent, receipts, store, tick: (ms: number) => { now += ms; } };
}

test("execute({intent_id, amount}) is rejected naming amount; nothing sent", async () => {
  const { kit, sent } = setup();
  const p = await kit.prepare("test.send", { amount: "5" });
  await assert.rejects(kit.execute({ intent_id: p.intent_id, amount: "999" } as never), /"amount"/);
  assert.equal(sent.length, 0);
});

test("prepare -> execute sends the stored tx once; second execute is rejected", async () => {
  const { kit, sent, receipts } = setup();
  const p = await kit.prepare("test.send", { amount: "5" });
  assert.equal(p.policy.ok, true);
  assert.equal(p.expires_at, new Date(T0 + policy.intent_ttl_s * 1000).toISOString());
  const r = await kit.execute({ intent_id: p.intent_id });
  assert.equal(r.status, "executed");
  assert.match(r.tx_hash ?? "", /^0x/);
  assert.equal(r.mandate.approval, "policy");
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /already executed/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.value, "5");
  assert.deepEqual((await receipts.read()).map((x) => x.status), ["prepared", "executed"]);
  assert.deepEqual(await receipts.verify(), { ok: true, broken_at: null });
});

test("concurrent executes send exactly one tx", async () => {
  const { kit, sent } = setup();
  const p = await kit.prepare("test.send", { amount: "5" });
  const out = await Promise.allSettled([kit.execute({ intent_id: p.intent_id }), kit.execute({ intent_id: p.intent_id })]);
  assert.equal(out.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(sent.length, 1);
});

test("tampered stored params or payload -> HMAC mismatch -> rejected", async () => {
  for (const tamper of [
    (r: IntentRecord) => { (r.params as { params: { amount: string } }).params.amount = "999"; },
    (r: IntentRecord) => { r.unsigned = { ...(r.unsigned as UnsignedEvmTx), value: "999" }; },
    (r: IntentRecord) => { r.intent.expires_at = "2099-01-01T00:00:00.000Z"; r.expires_at_ms = Date.UTC(2099, 0, 1); },
  ]) {
    const inner = memoryIntentStore();
    const store: IntentStore = {
      put: async (rec) => { tamper(rec); return inner.put(rec); },
      get: (id) => inner.get(id), consume: (id) => inner.consume(id),
    };
    const { kit, sent } = setup({ store });
    const p = await kit.prepare("test.send", { amount: "5" });
    await assert.rejects(kit.execute({ intent_id: p.intent_id }), /HMAC mismatch/);
    assert.equal(sent.length, 0);
  }
});

test("expired intent is rejected and writes an expired receipt", async () => {
  const { kit, sent, receipts, tick } = setup();
  const p = await kit.prepare("test.send", { amount: "5" });
  tick(policy.intent_ttl_s * 1000);
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /expired/);
  assert.equal(sent.length, 0);
  assert.deepEqual((await receipts.read()).map((x) => x.status), ["prepared", "expired"]);
});

test("refused intent is returned with rule/limit/observed and cannot execute", async () => {
  const { kit, sent, receipts } = setup({ refuseAll: true });
  const p = await kit.prepare("test.send", { amount: "5" });
  assert.equal(p.policy.ok, false);
  assert.deepEqual(p.policy.refusals.map((r) => [r.rule, r.limit, r.observed]), [["max_usd_per_trade", "0", "1"]]);
  assert.equal(p.unsigned.kind, "evm_tx");
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /max_usd_per_trade \(limit 0, observed 1\)/);
  assert.equal(sent.length, 0);
  assert.deepEqual((await receipts.read()).map((x) => x.status), ["refused"]);
});

test("prepare simulates before evaluating; a missing simulation yields simulation_required", async () => {
  const a = setup();
  await a.kit.prepare("test.send", { amount: "5" });
  assert.deepEqual(a.calls, ["simulate", "evaluate:sim"]);

  const b = setup({ noSim: true });
  const p = await b.kit.prepare("test.send", { amount: "5" });
  assert.deepEqual(b.calls, ["simulate", "evaluate:nosim"]);
  assert.equal(p.simulation, null);
  assert.equal(p.policy.ok, false);
  assert.ok(p.policy.refusals.some((r) => r.rule === "simulation_required"));
});

test("kit adds simulation_required even if the evaluator forgets it", async () => {
  const kit = createKit({ policy, rpc, secret: SECRET, actions: [sendAction], evaluate: () => ({ ok: true, refusals: [] }),
    simulate: async () => { throw new Error("down"); } });
  const p = await kit.prepare("test.send", { amount: "5" });
  assert.equal(p.policy.ok, false);
  assert.deepEqual(p.policy.refusals.map((r) => r.rule), ["simulation_required"]);
});

test("no signer -> execute rejected; unknown ids name themselves", async () => {
  const kit = createKit({ policy, rpc, actions: [sendAction, readAction], evaluate: () => ({ ok: true, refusals: [] }), simulate: async () => okSim });
  const p = await kit.prepare("test.send", { amount: "5" });
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /no signer/);
  await assert.rejects(kit.execute({ intent_id: "si_" + "A".repeat(43) }), /unknown intent_id/);
  await assert.rejects(kit.prepare("nope.x", {}), /unknown action "nope\.x"/);
  await assert.rejects(kit.read("nope.y", {}), /unknown action "nope\.y"/);
});

test("read runs only passive actions; describe adds approval hints; search matches id/title", async () => {
  const { kit } = setup();
  assert.deepEqual(await kit.read("test.read", { x: 2 }), { y: 4 });
  await assert.rejects(kit.read("test.send", {}), /not read-only/);
  const d = kit.describe("test.send") as unknown as { approval_hints: { destructiveHint: boolean; requiresUserInteraction: boolean } };
  assert.equal(d.approval_hints.destructiveHint, true);
  assert.equal(d.approval_hints.requiresUserInteraction, true);
  assert.deepEqual(kit.search("transfer").map((x) => x.id), ["test.send"]);
  assert.deepEqual(kit.search("test.read").map((x) => x.id), ["test.read"]);
});

test("failed send writes a failed receipt and the intent stays consumed", async () => {
  const sent: UnsignedEvmTx[] = [];
  const receipts = memoryReceiptLog();
  const kit = createKit({ policy, rpc, secret: SECRET, actions: [sendAction], signer: fakeSigner(sent, true), receipts,
    evaluate: () => ({ ok: true, refusals: [] }), simulate: async () => okSim });
  const p = await kit.prepare("test.send", { amount: "5" });
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /rpc down/);
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /already executed/);
  assert.deepEqual((await receipts.read()).map((x) => x.status), ["prepared", "failed"]);
});
