// Phase 2 wave 3: Safe Transaction Service API key + per-chain gateway base URL.
// Offline: recorded fixture, fake fetch, throwaway generated keys. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKit } from "../src/kit.js";
import { memoryReceiptLog } from "../src/receipts/index.js";
import { viemLocalSigner } from "../src/signers/index.js";
import { safeInfo, safeProposeAction, safeInfoAction } from "../src/safe/actions.js";
import { resolveSafeTxService, safeApiKeyFor, SAFE_API_KEY_ENV } from "../src/safe/service.js";
import { proposeToSafeTxService } from "../src/safe/index.js";
import { parsePolicyFile, validateReceipt } from "../src/spec/index.js";
import type { UnsignedTypedData } from "../src/spec/index.js";
import { ctxWith, fakeFetch, fixture, FIXED_NOW } from "./fixtures/actions-harness.js";

const REC = fixture("safe-info.base-sepolia.json");
const SAFE = REC.body.address as string;
const GATEWAY_GET = `https://api.safe.global/tx-service/basesep/api/v1/safes/${SAFE}/`;
const OWN_BASE = "https://safe-gateway.example.test/basesep";
const OWN_GET = `${OWN_BASE}/api/v1/safes/${SAFE}/`;
const KEY = "test-key-not-a-real-credential";

test("resolveSafeTxService: SAFE_API_KEY is read only when the caller opts in", () => {
  const env = { [SAFE_API_KEY_ENV]: KEY };
  assert.equal(resolveSafeTxService(undefined, env).apiKey, undefined);
  assert.equal(resolveSafeTxService({}, env).apiKey, undefined);
  assert.equal(resolveSafeTxService({ apiKeyFromEnv: true }, env).apiKey, KEY);
  assert.equal(resolveSafeTxService({ apiKey: "explicit", apiKeyFromEnv: true }, env).apiKey, "explicit");
  assert.equal(resolveSafeTxService({ apiKeyFromEnv: true }, {}).apiKey, undefined);
  assert.throws(() => resolveSafeTxService({ baseUrl: { base: "http://plain.example.test" } }), /https/);
});

test("safeApiKeyFor: the key goes only to Safe's gateway or a configured origin", () => {
  const s = resolveSafeTxService({ apiKey: KEY, baseUrl: { "base-sepolia": OWN_BASE } });
  assert.equal(safeApiKeyFor(s, GATEWAY_GET), KEY);
  assert.equal(safeApiKeyFor(s, OWN_GET), KEY);
  assert.equal(safeApiKeyFor(s, "https://elsewhere.example.test/api/v1/"), undefined);
  assert.equal(safeApiKeyFor(resolveSafeTxService({}), GATEWAY_GET), undefined);
});

test("safe.info: no key configured, no Authorization header", async () => {
  const f = fakeFetch([{ match: (u) => u === GATEWAY_GET, body: REC.body }]);
  await safeInfo({ chain: "base-sepolia", safe_address: SAFE }, ctxWith({ fetch: f.fetch, extra: { safeTxService: resolveSafeTxService(undefined, {}) } }));
  assert.equal(f.calls[0]!.headers.authorization, undefined);
});

test("safe.info: with a key, sends Authorization: Bearer to the gateway", async () => {
  const f = fakeFetch([{ match: (u) => u === GATEWAY_GET, body: REC.body }]);
  await safeInfo({ chain: "base-sepolia", safe_address: SAFE }, ctxWith({ fetch: f.fetch, extra: { safeTxService: resolveSafeTxService({ apiKey: KEY }) } }));
  assert.equal(f.calls[0]!.headers.authorization, `Bearer ${KEY}`);
});

test("safe.info: per-chain base URL override is used and reported as service_url", async () => {
  const f = fakeFetch([{ match: (u) => u === OWN_GET, body: REC.body }]);
  const out = await safeInfo({ chain: "base-sepolia", safe_address: SAFE }, ctxWith({ fetch: f.fetch, extra: { safeTxService: resolveSafeTxService({ baseUrl: { "base-sepolia": `${OWN_BASE}/` } }) } }));
  assert.equal(f.calls[0]!.url, OWN_GET);
  assert.equal(out.service_url, OWN_BASE);
});

test("safe.info: an error answer never carries the key", async () => {
  const f = fakeFetch([{ match: (u) => u === GATEWAY_GET, body: { detail: "Invalid token." }, status: 401 }]);
  await assert.rejects(
    safeInfo({ chain: "base-sepolia", safe_address: SAFE }, ctxWith({ fetch: f.fetch, extra: { safeTxService: resolveSafeTxService({ apiKey: KEY }) } })),
    (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes(KEY),
  );
});

test("proposeToSafeTxService: apiKey option becomes the Authorization header", async () => {
  const f = fakeFetch([{ match: () => true, status: 201 }]);
  const td = {
    kind: "typed_data", chain: "base-sepolia", signer: "0x2222222222222222222222222222222222222222",
    domain: { chainId: 84532, verifyingContract: SAFE },
    types: { SafeTx: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" }] },
    primaryType: "SafeTx",
    message: { to: SAFE, value: "0", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce: "0" },
    submit: { kind: "safe_tx_service", url: "https://api.safe.global/tx-service/basesep", safe_address: SAFE },
  } as unknown as UnsignedTypedData;
  await proposeToSafeTxService(td, `0x${"11".repeat(65)}`, { fetch: f.fetch, apiKey: KEY });
  assert.equal(f.calls[0]!.headers.authorization, `Bearer ${KEY}`);
  await proposeToSafeTxService(td, `0x${"11".repeat(65)}`, { fetch: f.fetch });
  assert.equal(f.calls[1]!.headers.authorization, undefined);
});

test("kit: safe.propose end to end with a key and an override reaches only the configured gateway", async () => {
  const signer = viemLocalSigner({ generate: true, rpc: () => { throw new Error("no rpc"); } });
  const owner = await signer.address("base-sepolia");
  const body = { ...REC.body, owners: [...(REC.body.owners as string[]), owner] };
  const f = fakeFetch([
    { match: (u) => u === OWN_GET, body },
    { match: (u) => u.startsWith(`${OWN_BASE}/api/v1/safes/`) && u.endsWith("/multisig-transactions/"), status: 201 },
  ]);
  const parsed = parsePolicyFile({ schema: "sato.policy/v1", version: 1, network: "testnet", allow_recipients: ["base-sepolia:0x000000000000000000000000000000000000dEaD"] } as never);
  if (!parsed.ok) throw new Error(parsed.error);
  const receipts = memoryReceiptLog();
  const kit = createKit({
    policy: parsed.policy, rpc: () => { throw new Error("no rpc"); }, secret: new Uint8Array(32).fill(5), clock: () => FIXED_NOW,
    actions: [safeInfoAction(), safeProposeAction()], signer, receipts, fetch: f.fetch,
    safeTxService: { apiKey: KEY, baseUrl: { "base-sepolia": OWN_BASE } },
  });
  const p = await kit.prepare("safe.propose", { chain: "base-sepolia", safe_address: SAFE, call: { to: "0x000000000000000000000000000000000000dEaD", value: "0" } });
  assert.equal(p.policy.ok, true, JSON.stringify(p.policy.refusals));
  const r = await kit.execute({ intent_id: p.intent_id });
  assert.equal(r.status, "executed");
  assert.match(String(r.safe_tx_hash), /^0x[0-9a-f]{64}$/i);
  assert.equal(validateReceipt(r).ok, true);
  assert.ok(f.calls.length >= 2);
  for (const c of f.calls) {
    assert.ok(c.url.startsWith(OWN_BASE), c.url);
    assert.equal(c.headers.authorization, `Bearer ${KEY}`);
  }
  assert.ok(!JSON.stringify(await receipts.read()).includes(KEY));
});
