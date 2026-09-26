import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECEIPT_GENESIS_PREV_HASH, validateReceipt } from "../src/spec/index.js";
import { memoryReceiptLog, fileReceiptLog } from "../src/receipts/index.js";
import type { ReceiptDraft } from "../src/types.js";

const draft = (n: number): ReceiptDraft => ({
  intent_id: "si_" + String(n).repeat(43).slice(0, 43), action: "test.send", chain: "base-sepolia",
  params_digest: "sha256:" + "a".repeat(64), policy: { ok: true, refusals: [] }, simulation: null, fee_disclosure: null,
  tx_hash: null, status: "prepared", created_at: "2026-09-26T12:00:00.000Z",
  mandate: { kind: "intent", intent_id: "si_" + String(n).repeat(43).slice(0, 43), action: "test.send", policy_digest: "sha256:" + "b".repeat(64), expires_at: "2026-09-26T12:05:00.000Z", approval: "none" },
});

test("memory log chains from genesis and verifies", async () => {
  const log = memoryReceiptLog();
  const [a, b] = await Promise.all([log.append(draft(1)), log.append(draft(2))]);
  assert.equal(a.seq, 0);
  assert.equal(a.prev_hash, RECEIPT_GENESIS_PREV_HASH);
  assert.equal(b.seq, 1);
  assert.equal(b.prev_hash, a.hash);
  assert.deepEqual(await log.verify(), { ok: true, broken_at: null });
  const v = validateReceipt(a);
  assert.equal(v.ok, true, JSON.stringify(v));
});

test("file log: a tampered line is detected at its index", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "kit-rcpt-")), "receipts.jsonl");
  const log = fileReceiptLog(path);
  for (let i = 1; i <= 4; i++) await log.append(draft(i));
  assert.deepEqual(await log.verify(), { ok: true, broken_at: null });
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const l2 = JSON.parse(lines[2]!);
  l2.tx_hash = "0x" + "f".repeat(64);
  lines[2] = JSON.stringify(l2);
  await writeFile(path, lines.join("\n") + "\n");
  assert.deepEqual(await log.verify(), { ok: false, broken_at: 2 });
  // dropping a line breaks linkage at that index too
  await writeFile(path, [lines[0], lines[1], lines[3]].join("\n") + "\n");
  assert.deepEqual(await log.verify(), { ok: false, broken_at: 2 });
  await writeFile(path, [lines[0], "{not json"].join("\n") + "\n");
  assert.deepEqual(await log.verify(), { ok: false, broken_at: 1 });
});
