import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { INTENT_ID_RE, intentIdMacInput, base64url } from "../src/spec/index.js";
import { computeIntentId, verifyIntentId, paramsDigest, memoryIntentStore, fileIntentStore, loadOrCreateIntentSecret } from "../src/intent/index.js";
import type { IntentRecord } from "../src/types.js";
import { SECRET, tx } from "./kit-fixtures.js";

const fields = { action: "test.send", params_digest: paramsDigest({ a: 1 }), expires_at: "2026-09-26T12:05:00.000Z", nonce: "AAAAAAAAAAAAAAAAAAAAAA" };

test("intent_id matches the frozen contract byte for byte", () => {
  const id = computeIntentId(SECRET, fields);
  assert.match(id, INTENT_ID_RE);
  const mac = createHmac("sha256", SECRET).update(intentIdMacInput(fields)).digest();
  assert.equal(id, "si_" + base64url(new Uint8Array(mac)));
  assert.match(fields.params_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(paramsDigest({ b: 1, a: 2 }), paramsDigest({ a: 2, b: 1 }));
});

test("verifyIntentId rejects any changed field or secret", () => {
  const id = computeIntentId(SECRET, fields);
  assert.equal(verifyIntentId(SECRET, id, fields), true);
  assert.equal(verifyIntentId(SECRET, id, { ...fields, params_digest: paramsDigest({ a: 2 }) }), false);
  assert.equal(verifyIntentId(new Uint8Array(32).fill(8), id, fields), false);
  assert.equal(verifyIntentId(SECRET, "si_short", fields), false);
});

function record(): IntentRecord {
  const id = computeIntentId(SECRET, fields);
  return {
    intent: { intent_id: id, action: "test.send", expires_at: fields.expires_at, summary: "s", policy: { ok: true, refusals: [] }, simulation: null, fee_disclosure: null, unsigned: tx },
    params: { a: 1 }, params_digest: fields.params_digest, unsigned: tx, nonce: fields.nonce, expires_at_ms: 0,
  };
}

for (const [name, make] of [["memory", async () => memoryIntentStore()], ["file", async () => fileIntentStore(await mkdtemp(join(tmpdir(), "kit-intent-")))]] as const) {
  test(`${name} store: consume is exactly-once`, async () => {
    const s = await make();
    const r = record();
    await s.put(r);
    assert.deepEqual((await s.get(r.intent.intent_id))?.params, { a: 1 });
    const results = await Promise.all([s.consume(r.intent.intent_id), s.consume(r.intent.intent_id), s.consume(r.intent.intent_id)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await s.consume(r.intent.intent_id), null);
    assert.equal(await s.get("si_" + "A".repeat(43)), null);
  });
}

test("file store writes 0600 files and refuses non-id names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kit-intent-"));
  const s = fileIntentStore(dir);
  const r = record();
  await s.put(r);
  const files = await readdir(dir);
  assert.deepEqual(files, [`${r.intent.intent_id}.json`]);
  assert.equal((await stat(join(dir, files[0]))).mode & 0o777, 0o600);
  await assert.rejects(s.get("../etc/passwd"), /not an intent id/);
});

test("loadOrCreateIntentSecret persists a 0600 key and reloads it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kit-key-"));
  const a = await loadOrCreateIntentSecret(dir);
  const b = await loadOrCreateIntentSecret(dir);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  assert.equal((await stat(join(dir, "intent.key"))).mode & 0o777, 0o600);
});
