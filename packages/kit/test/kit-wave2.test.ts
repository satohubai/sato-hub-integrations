// Phase 2 wave 2: typed_data (Safe Transaction Service) and solana_tx payloads.
// Offline: fake Solana RPC, fake fetch, throwaway in-memory keys. No mainnet, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address as solAddress,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { recoverTypedDataAddress } from "viem";
import { createKit, TYPED_DATA_NO_SIMULATION_REASON } from "../src/kit.js";
import { memoryReceiptLog } from "../src/receipts/index.js";
import { humanApprove, solanaLocalSigner, viemLocalSigner } from "../src/signers/index.js";
import { SOLANA_MAINNET_GENESIS_HASH, solanaJsonRpc } from "../src/solana/index.js";
import { SOLANA_SIGNATURE_RE, validateReceipt, validateUnsignedPayload } from "../src/spec/index.js";
import type { UnsignedSolanaTx, UnsignedTypedData } from "../src/spec/index.js";
import type { PrepareAction, Signer, SolanaRpc } from "../src/types.js";
import { SECRET, T0, descriptor, fakeEvaluator, fakeSigner, okSim, policy, rpc } from "./kit-fixtures.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const BLOCKHASH = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SAFE = "0x1111111111111111111111111111111111111111";
const SERVICE = "https://safe-transaction-base-sepolia.safe.global";

// ── typed_data ──────────────────────────────────────────────────────────────

function safeTx(signer: string, submit: UnsignedTypedData["submit"]): UnsignedTypedData {
  return {
    kind: "typed_data", chain: "base-sepolia", chain_id: 84532, signer,
    domain: { chainId: 84532, verifyingContract: SAFE },
    types: {
      SafeTx: [
        { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    message: {
      to: "0x000000000000000000000000000000000000dEaD", value: "1000", data: "0x", operation: 0, safeTxGas: "0", baseGas: "0",
      gasPrice: "0", gasToken: "0x0000000000000000000000000000000000000000", refundReceiver: "0x0000000000000000000000000000000000000000", nonce: "7",
    },
    submit,
  };
}

function typedAction(td: UnsignedTypedData): PrepareAction {
  return {
    descriptor: descriptor("test.safe_propose", ["sign"], "Propose a Safe transaction"),
    async build() {
      return {
        params: { nonce: 7 }, unsigned: td,
        facts: { action: "test.safe_propose", chain: "base-sepolia", network: "testnet", usd_value: 1, usd_spent_today: 0 },
        summary: "Propose sending 1000 wei from the Safe.", fee_disclosure: null,
      };
    },
  };
}

type Posted = { url: string; body: Record<string, unknown> };
function fakeFetch(posted: Posted[], status = 201): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(status === 201 ? null : '{"nonce":["already used"]}', { status });
  }) as typeof fetch;
}

async function typedSetup(submit: boolean, status = 201) {
  const signer = viemLocalSigner({ generate: true, rpc });
  const addr = await signer.address("base-sepolia");
  const td = safeTx(addr, submit ? { kind: "safe_tx_service", url: SERVICE, safe_address: SAFE } : null);
  assert.equal(validateUnsignedPayload(td).ok, true);
  const posted: Posted[] = [];
  const calls: string[] = [];
  const receipts = memoryReceiptLog();
  const kit = createKit({
    policy, rpc, secret: SECRET, clock: () => T0, actions: [typedAction(td)], signer, receipts,
    evaluate: fakeEvaluator(calls), fetch: fakeFetch(posted, status),
    simulate: async () => { calls.push("simulate"); return okSim; },
  });
  return { kit, posted, calls, addr, td, receipts };
}

test("typed_data: prepare skips simulation and states why; simulation_required does not apply", async () => {
  const { kit, calls } = await typedSetup(true);
  const p = await kit.prepare("test.safe_propose", {});
  assert.equal(p.simulation, null);
  assert.equal(p.policy.ok, true);
  assert.ok(p.summary.includes(TYPED_DATA_NO_SIMULATION_REASON));
  assert.ok(!calls.includes("simulate"));
});

test("typed_data with submit: signs, POSTs to the Safe Transaction Service, receipt carries safe_tx_hash", async () => {
  const { kit, posted, addr, td, receipts } = await typedSetup(true);
  const p = await kit.prepare("test.safe_propose", {});
  const r = await kit.execute({ intent_id: p.intent_id });
  assert.equal(r.status, "executed");
  assert.equal(r.tx_hash, null);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.url, `${SERVICE}/api/v1/safes/${SAFE}/multisig-transactions/`);
  const body = posted[0]!.body;
  assert.equal(r.safe_tx_hash, body.contractTransactionHash);
  assert.equal(body.sender, addr);
  assert.equal(body.nonce, "7");
  const { EIP712Domain: _drop, ...types } = td.types as Record<string, never>;
  void _drop;
  const recovered = await recoverTypedDataAddress({ domain: td.domain as never, types, primaryType: "SafeTx", message: td.message as never, signature: body.signature as `0x${string}` });
  assert.equal(recovered, addr);
  assert.equal(validateReceipt(r).ok, true);
  assert.equal((await receipts.verify()).ok, true);
});

test("typed_data without submit: signs only, no HTTP call, no safe_tx_hash", async () => {
  const { kit, posted } = await typedSetup(false);
  const r = await kit.execute({ intent_id: (await kit.prepare("test.safe_propose", {})).intent_id });
  assert.equal(r.status, "executed");
  assert.equal(posted.length, 0);
  assert.equal("safe_tx_hash" in r, false);
});

test("typed_data: a Safe Transaction Service error fails the intent and quotes the answer", async () => {
  const { kit, receipts } = await typedSetup(true, 422);
  const p = await kit.prepare("test.safe_propose", {});
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /HTTP 422.*already used/);
  const log = await receipts.read();
  assert.equal(log.at(-1)!.status, "failed");
});

// ── solana_tx ───────────────────────────────────────────────────────────────

async function unsignedSolana(feePayer: string, chain: UnsignedSolanaTx["chain"] = "solana-devnet"): Promise<UnsignedSolanaTx> {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(solAddress(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(BLOCKHASH), lastValidBlockHeight: 1000n }, m),
    (m) => appendTransactionMessageInstruction({ programAddress: solAddress(MEMO_PROGRAM), data: new TextEncoder().encode("sato-kit test") }, m),
  );
  const tx = compileTransaction(msg);
  return { kind: "solana_tx", chain, fee_payer: feePayer, transaction_base64: getBase64EncodedWireTransaction(tx), recent_blockhash: BLOCKHASH, last_valid_block_height: 1000 };
}

function fakeSolanaRpc(o: { simErr?: unknown; genesis?: string } = {}): { rpc: SolanaRpc; calls: Array<{ method: string; params: readonly unknown[] }> } {
  const calls: Array<{ method: string; params: readonly unknown[] }> = [];
  return {
    calls,
    rpc: {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "simulateTransaction") return { context: { slot: 4242 }, value: { err: o.simErr ?? null, logs: o.simErr ? ["Program failed: custom error"] : [], unitsConsumed: 1234 } };
        if (method === "getGenesisHash") return o.genesis ?? DEVNET_GENESIS;
        if (method === "sendTransaction") {
          const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(params[0] as string));
          const sig = Object.values(decoded.signatures)[0];
          assert.ok(sig, "sent transaction is signed");
          const { getBase58Decoder } = await import("@solana/kit");
          return getBase58Decoder().decode(sig!);
        }
        throw new Error(`unexpected method ${method}`);
      },
    },
  };
}

function solanaAction(u: UnsignedSolanaTx): PrepareAction {
  return {
    descriptor: descriptor("test.sol_send", ["sign", "broadcast"], "Send a Solana memo"),
    async build() {
      return {
        params: { memo: "sato-kit test" }, unsigned: u,
        facts: { action: "test.sol_send", chain: "base-sepolia", network: "testnet", usd_value: 0, usd_spent_today: 0 },
        summary: "Send a memo on Solana devnet.", fee_disclosure: null,
      };
    },
  };
}

async function solSetup(o: { simErr?: unknown; noRpc?: boolean; signer?: Signer } = {}) {
  const fake = fakeSolanaRpc(o);
  const local = solanaLocalSigner({ generate: true, rpc: () => fake.rpc });
  const u = await unsignedSolana(await local.publicKey());
  assert.equal(validateUnsignedPayload(u).ok, true);
  const receipts = memoryReceiptLog();
  const kit = createKit({
    policy, rpc, secret: SECRET, clock: () => T0, actions: [solanaAction(u)], signer: o.signer ?? local, receipts,
    evaluate: fakeEvaluator([]), solanaRpc: o.noRpc ? undefined : () => fake.rpc,
    fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
  });
  return { kit, fake, local, u, receipts };
}

test("solana_tx: prepare simulates with simulateTransaction (sigVerify false) and requires success", async () => {
  const { kit, fake } = await solSetup();
  const p = await kit.prepare("test.sol_send", {});
  assert.equal(p.policy.ok, true);
  assert.deepEqual({ ...p.simulation, as_of: "" }, { ok: true, method: "simulateTransaction", block: "4242", gas_estimate: "1234", error: null, as_of: "" });
  const sim = fake.calls.find((c) => c.method === "simulateTransaction")!;
  assert.equal((sim.params[1] as { sigVerify: boolean }).sigVerify, false);
  assert.equal((sim.params[1] as { encoding: string }).encoding, "base64");
});

test("solana_tx: a failed simulation refuses with simulation_failed", async () => {
  const { kit } = await solSetup({ simErr: { InstructionError: [0, { Custom: 1 }] } });
  const p = await kit.prepare("test.sol_send", {});
  assert.equal(p.policy.ok, false);
  assert.ok(p.policy.refusals.some((r) => r.rule === "simulation_failed" && /InstructionError/.test(r.observed)));
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /simulation_failed/);
});

test("solana_tx: no Solana RPC means not simulated, refused with simulation_required", async () => {
  const { kit } = await solSetup({ noRpc: true });
  const p = await kit.prepare("test.sol_send", {});
  assert.equal(p.simulation, null);
  assert.ok(p.policy.refusals.some((r) => r.rule === "simulation_required"));
});

test("solana_tx: execute signs and sends on devnet; receipt carries the signature, tx_hash stays null", async () => {
  const { kit, fake, local, u, receipts } = await solSetup();
  const p = await kit.prepare("test.sol_send", {});
  const r = await kit.execute({ intent_id: p.intent_id });
  assert.equal(r.status, "executed");
  assert.equal(r.tx_hash, null);
  assert.match(r.signature ?? "", SOLANA_SIGNATURE_RE);
  assert.equal(r.signature, (await local.signSolanaTransaction(u)).signature, "Ed25519 is deterministic: same key + message, same signature");
  assert.deepEqual(fake.calls.map((c) => c.method), ["simulateTransaction", "getGenesisHash", "sendTransaction"]);
  assert.equal(validateReceipt(r).ok, true);
  assert.equal((await receipts.verify()).ok, true);
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /already executed/);
});

test("solana_tx: a signer without the optional Solana capability fails naming it, and the intent stays unconsumed", async () => {
  const { kit, receipts } = await solSetup({ signer: fakeSigner([]) });
  const p = await kit.prepare("test.sol_send", {});
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /lacks the optional sendSolanaTransaction capability/);
  await assert.rejects(kit.execute({ intent_id: p.intent_id }), /lacks the optional sendSolanaTransaction capability/);
  assert.deepEqual((await receipts.read()).map((x) => x.status), ["prepared"]);
});

test("solanaLocalSigner refuses mainnet: by chain label and by the RPC's genesis hash", async () => {
  const fake = fakeSolanaRpc({ genesis: SOLANA_MAINNET_GENESIS_HASH });
  const s = solanaLocalSigner({ generate: true, rpc: () => fake.rpc });
  const pk = await s.publicKey();
  await assert.rejects(s.signSolanaTransaction(await unsignedSolana(pk, "solana")), /devnet-only/);
  await assert.rejects(s.sendSolanaTransaction(await unsignedSolana(pk, "solana")), /devnet-only/);
  await assert.rejects(s.sendSolanaTransaction(await unsignedSolana(pk)), /mainnet-beta genesis/);
  assert.equal(fake.calls.some((c) => c.method === "sendTransaction"), false);
  await assert.rejects(s.sendTransaction({} as never), /Solana transactions only/);
  assert.throws(() => solanaLocalSigner({ secretKey: new Uint8Array(32) }), /64-byte/);
});

test("solanaLocalSigner refuses a transaction whose fee payer is another key", async () => {
  const s = solanaLocalSigner({ generate: true });
  const other = solanaLocalSigner({ generate: true });
  await assert.rejects(s.signSolanaTransaction(await unsignedSolana(await other.publicKey())), /fee_payer/);
});

test("humanApprove exposes the Solana capability only behind approval", async () => {
  const fake = fakeSolanaRpc();
  const inner = solanaLocalSigner({ generate: true, rpc: () => fake.rpc });
  const u = await unsignedSolana(await inner.publicKey());
  const no = humanApprove(inner, async () => false);
  await assert.rejects(no.sendSolanaTransaction!(u), /not approved/);
  const seen: string[] = [];
  const yes = humanApprove(inner, async (s) => { seen.push(s.kind); return true; });
  assert.match((await yes.sendSolanaTransaction!(u)).signature, SOLANA_SIGNATURE_RE);
  assert.deepEqual(seen, ["solana_tx"]);
  assert.equal(humanApprove(fakeSigner([]), async () => true).sendSolanaTransaction, undefined);
});

test("solanaJsonRpc posts JSON-RPC 2.0 and surfaces a JSON-RPC error", async () => {
  const bodies: unknown[] = [];
  const f = (async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    return Response.json(b.method === "getGenesisHash" ? { jsonrpc: "2.0", id: b.id, result: DEVNET_GENESIS } : { jsonrpc: "2.0", id: b.id, error: { code: -32002, message: "Transaction simulation failed" } });
  }) as typeof fetch;
  const r = solanaJsonRpc("https://api.devnet.solana.com", { fetch: f });
  assert.equal(await r.request("getGenesisHash", []), DEVNET_GENESIS);
  await assert.rejects(r.request("sendTransaction", ["AA=="]), /-?Transaction simulation failed/);
  assert.deepEqual(bodies[0], { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] });
});
