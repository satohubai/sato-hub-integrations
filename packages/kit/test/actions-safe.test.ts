// safe.info / safe.propose. Offline: the Safe Transaction Service answer is a
// recorded fixture (base-sepolia); signing uses a throwaway generated key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress } from "viem";
import { createKit } from "../src/kit.js";
import { memoryReceiptLog } from "../src/receipts/index.js";
import { viemLocalSigner } from "../src/signers/index.js";
import { buildSafePropose, safeInfo, safeDomain, safeProposeAction, safeInfoAction, SAFE_TX_SERVICE_SHORT_NAMES } from "../src/safe/actions.js";
import { lintActionDescriptor, parsePolicyFile, validateUnsignedPayload } from "../src/spec/index.js";
import type { UnsignedEvmTx, UnsignedTypedData } from "../src/spec/index.js";
import { ctxWith, fakeFetch, fixture, FIXED_NOW } from "./fixtures/actions-harness.js";

const REC = fixture("safe-info.base-sepolia.json");
const SAFE = REC.body.address as string;
const OWNER = REC.body.owners[1] as string;
const SERVICE_GET = `https://api.safe.global/tx-service/basesep/api/v1/safes/${SAFE}/`;
const TARGET = "0x000000000000000000000000000000000000dEaD";

const route = (body = REC.body, status = 200) => ({ match: (u: string) => u === SERVICE_GET, body, status });

test("safe.info reads owners, threshold and nonce from the recorded service answer", async () => {
  const f = fakeFetch([route()]);
  const out = await safeInfo({ chain: "base-sepolia", safe_address: SAFE }, ctxWith({ fetch: f.fetch }));
  assert.equal(REC.request, `GET ${SERVICE_GET}`);
  assert.equal(out.nonce, "1");
  assert.equal(out.threshold, 1);
  assert.deepEqual(out.owners, REC.body.owners);
  assert.equal(out.version, "1.3.0+L2");
  assert.equal(out.guard, null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.method, "GET");
  assert.ok(f.calls[0]!.headers["user-agent"]);
  assert.equal(f.calls[0]!.headers.authorization, undefined);
});

test("safe.info: a 404 is an input error naming the Safe", async () => {
  const f = fakeFetch([route({ detail: "Not found" } as never, 404)]);
  await assert.rejects(safeInfo({ chain: "base-sepolia", safe_address: SAFE }, ctxWith({ fetch: f.fetch })), /no Safe at/);
});

test("safe.propose builds SafeTx typed data with the Safe's domain and nonce; facts come from the inner call", async () => {
  const f = fakeFetch([route()]);
  const b = await buildSafePropose({ chain: "base-sepolia", safe_address: SAFE, signer: OWNER, call: { to: TARGET, value: "1000" } }, ctxWith({ fetch: f.fetch }));
  const u = b.unsigned as UnsignedTypedData;
  assert.equal(validateUnsignedPayload(u).ok, true);
  assert.equal(u.kind, "typed_data");
  assert.equal(u.primaryType, "SafeTx");
  assert.deepEqual(u.domain, { chainId: 84532, verifyingContract: SAFE });
  assert.equal(u.message.nonce, "1");
  assert.equal(u.message.operation, 0);
  assert.deepEqual(u.submit, { kind: "safe_tx_service", url: "https://api.safe.global/tx-service/basesep", safe_address: SAFE });
  assert.equal(b.facts.recipient, TARGET);
  assert.equal(b.facts.contract, undefined);
  assert.equal(b.facts.token, "ETH");
  assert.equal(b.facts.token_amount_base_units, "1000");
  assert.equal(b.facts.usd_value, null);
  assert.match(b.summary, /1 signature\(s\) are needed/);
});

test("safe.propose accepts another prepare's evm_tx; calldata makes the target the contract fact", async () => {
  const f = fakeFetch([route()]);
  const inner: UnsignedEvmTx = { kind: "evm_tx", chain: "base-sepolia", chain_id: 84532, from: SAFE, to: TARGET, data: "0x095ea7b3", value: "0" };
  const b = await buildSafePropose({ chain: "base-sepolia", safe_address: SAFE, signer: OWNER, inner_tx: inner }, ctxWith({ fetch: f.fetch }));
  assert.equal(b.facts.contract, TARGET);
  assert.equal(b.facts.recipient, undefined);
  assert.equal(b.facts.usd_value, 0);
  const wrongFrom = { ...inner, from: OWNER };
  await assert.rejects(buildSafePropose({ chain: "base-sepolia", safe_address: SAFE, signer: OWNER, inner_tx: wrongFrom }, ctxWith({ fetch: f.fetch })), /not from the Safe/);
  await assert.rejects(buildSafePropose({ chain: "base-sepolia", safe_address: SAFE, signer: OWNER, inner_tx: { ...inner, chain: "base", chain_id: 8453 } }, ctxWith({ fetch: f.fetch })), /not base-sepolia/);
});

test("safe.propose refuses a signer that is not an owner, and a stale nonce", async () => {
  const f = fakeFetch([route()]);
  await assert.rejects(
    buildSafePropose({ chain: "base-sepolia", safe_address: SAFE, signer: TARGET, call: { to: TARGET } }, ctxWith({ fetch: f.fetch })),
    /is not an owner/,
  );
  await assert.rejects(
    buildSafePropose({ chain: "base-sepolia", safe_address: SAFE, signer: OWNER, call: { to: TARGET }, nonce: "0" }, ctxWith({ fetch: f.fetch })),
    /below the Safe's current nonce/,
  );
});

test("safeDomain: chainId only from v1.3.0; pre-1.1.0 refused", () => {
  assert.deepEqual(safeDomain("1.4.1", 1, SAFE), { chainId: 1, verifyingContract: SAFE });
  assert.deepEqual(safeDomain("1.2.0", 1, SAFE), { verifyingContract: SAFE });
  assert.throws(() => safeDomain("1.0.0", 1, SAFE), /predates/);
  assert.throws(() => safeDomain(null, 1, SAFE), /unknown/);
});

test("end to end: prepare -> execute signs as an owner and POSTs the proposal; policy applies to the inner call", async () => {
  // A throwaway key, added to the recorded owner list for this test only (labelled: not the recorded Safe's owner set).
  const signer = viemLocalSigner({ generate: true, rpc: () => { throw new Error("no rpc"); } });
  const me = await signer.address("base-sepolia");
  const body = { ...REC.body, owners: [...REC.body.owners, me] };
  const f = fakeFetch([route(body), { match: (u) => u.endsWith("/multisig-transactions/"), status: 201 }]);
  const parsed = parsePolicyFile({ schema: "sato.policy/v1", version: 1, network: "testnet", allow_recipients: [`base-sepolia:${TARGET}`] } as never);
  if (!parsed.ok) throw new Error(parsed.error);
  const receipts = memoryReceiptLog();
  const kit = createKit({
    policy: parsed.policy, secret: new Uint8Array(32).fill(3), clock: () => FIXED_NOW, signer, receipts, fetch: f.fetch,
    rpc: () => { throw new Error("no rpc"); }, actions: [safeProposeAction(), safeInfoAction()],
  });
  const p = await kit.prepare("safe.propose", { chain: "base-sepolia", safe_address: SAFE, call: { to: TARGET, value: "0" } });
  assert.equal(p.policy.ok, true, JSON.stringify(p.policy.refusals));
  assert.equal(p.simulation, null);
  const r = await kit.execute({ intent_id: p.intent_id });
  assert.equal(r.status, "executed");
  assert.equal(r.tx_hash, null);
  assert.match(String(r.safe_tx_hash), /^0x[0-9a-f]{64}$/);
  const post = f.calls.find((c) => c.method === "POST")!;
  assert.equal(post.url, `https://api.safe.global/tx-service/basesep/api/v1/safes/${SAFE}/multisig-transactions/`);
  const pb = post.body as Record<string, string>;
  assert.equal(pb.contractTransactionHash, r.safe_tx_hash);
  const u = p.unsigned as UnsignedTypedData;
  const { EIP712Domain: _d, ...types } = u.types;
  void _d;
  const rec = await (recoverTypedDataAddress as (p: any) => Promise<string>)({ domain: u.domain as never, types: types as never, primaryType: "SafeTx", message: u.message as never, signature: pb.signature as `0x${string}` });
  assert.equal(rec, me);

  // A recipient outside the allowlist is refused by the pre-flight, naming the rule.
  const other = await kit.prepare("safe.propose", { chain: "base-sepolia", safe_address: SAFE, call: { to: "0x000000000000000000000000000000000000bEEF" } });
  assert.equal(other.policy.ok, false);
  assert.ok(other.policy.refusals.some((x) => x.rule === "recipient_allowlist"));
});

test("descriptors lint clean, name no claims, and the chain map has only service-backed chains", () => {
  for (const a of [safeInfoAction(), safeProposeAction()]) {
    assert.deepEqual(lintActionDescriptor(a.descriptor as never), []);
    assert.doesNotMatch(a.descriptor.description, /\bsafe(ly|ty)?\b|guarantee/);
  }
  assert.deepEqual(Object.keys(SAFE_TX_SERVICE_SHORT_NAMES).sort(), ["arbitrum", "base", "base-sepolia", "ethereum", "optimism", "polygon", "sepolia"]);
});
