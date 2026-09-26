import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpRequestError } from "viem";
import { chainRead, erc8004Lookup, simulateTx, txSimulateAction, ERC8004_IDENTITY_REGISTRY } from "../src/actions/index.js";
import type { UnsignedEvmTx } from "../src/spec/index.js";
import { ctxWith, fakeClient } from "./fixtures/actions-harness.js";

const TX: UnsignedEvmTx = { kind: "evm_tx", chain: "base", chain_id: 8453, from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", data: "0x", value: "0" };
const unreachable = () => new HttpRequestError({ url: "http://127.0.0.1:1", details: "fetch failed" });
const revert = (reason: string) => Object.assign(new Error(`execution reverted: ${reason}`), { name: "ContractFunctionExecutionError", cause: Object.assign(new Error("reverted"), { name: "ExecutionRevertedError", reason }) });

test("tx.simulate: ok with a gas estimate when call and estimate succeed", async () => {
  const { client } = fakeClient({ getBlockNumber: async () => 123n, call: async () => ({ data: "0x" }), estimateGas: async () => 21000n });
  const r = await simulateTx(TX, ctxWith({ client }));
  assert.deepEqual(r, { ok: true, method: "eth_call+eth_estimateGas", block: "123", gas_estimate: "21000", error: null, as_of: "2026-09-26T12:00:00.000Z" });
});

test("tx.simulate never reports ok when the RPC is unreachable", async () => {
  const cases = [
    ctxWith({ rpcThrows: true }),
    ctxWith({ client: fakeClient({ getBlockNumber: async () => { throw unreachable(); } }).client }),
    ctxWith({ client: fakeClient({ getBlockNumber: async () => 1n, call: async () => { throw unreachable(); } }).client }),
    ctxWith({ client: fakeClient({ getBlockNumber: async () => 1n, call: async () => ({}), estimateGas: async () => { throw unreachable(); } }).client }),
  ];
  for (const ctx of cases) {
    const r = await simulateTx(TX, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error, "rpc_unreachable");
    assert.equal(r.gas_estimate, null);
  }
});

test("tx.simulate: a revert is ok false with the reason", async () => {
  const { client } = fakeClient({ getBlockNumber: async () => 9n, call: async () => { throw revert("STF"); } });
  const r = await simulateTx(TX, ctxWith({ client }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "reverted: STF");
  assert.equal(r.block, "9");
});

test("tx.simulate as a read action validates input", async () => {
  const { client } = fakeClient({ getBlockNumber: async () => 1n, call: async () => ({}), estimateGas: async () => 5n });
  const out = await txSimulateAction().run({ chain: "base", to: TX.to, data: "0x" }, ctxWith({ client }));
  assert.equal(out.ok, true);
  await assert.rejects(txSimulateAction().run({ chain: "base", to: "nope", data: "0x" }, ctxWith({ client })));
});

test("chain.read: a non-view function is refused before any RPC call", async () => {
  const { client, touched } = fakeClient({});
  const abi = { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ name: "", type: "bool" }] };
  await assert.rejects(chainRead({ kind: "contract_read", chain: "base", contract: TX.to, abi, args: [TX.from, "1"] }, ctxWith({ client })), /only view or pure/);
  assert.deepEqual(touched, []);
});

test("chain.read: balances and contract reads come back as decimal strings", async () => {
  const { client } = fakeClient({
    getBlockNumber: async () => 77n,
    getBalance: async () => 5n * 10n ** 18n,
    readContract: async (a: { functionName: string; args: unknown[] }) => (a.functionName === "decimals" ? 6 : a.functionName === "totalSupply" ? 42n : 1000n),
  });
  const ctx = ctxWith({ client });
  assert.deepEqual(await chainRead({ kind: "block_number", chain: "base" }, ctx), { kind: "block_number", chain: "base", block_number: "77", result: "77", as_of: "2026-09-26T12:00:00.000Z" });
  assert.equal((await chainRead({ kind: "native_balance", chain: "base", address: TX.from }, ctx)).result, "5000000000000000000");
  assert.equal((await chainRead({ kind: "erc20_balance", chain: "base", token: TX.to, owner: TX.from }, ctx)).result, "1000");
  const abi = { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] };
  assert.equal((await chainRead({ kind: "contract_read", chain: "base", contract: TX.to, abi, args: [] }, ctx)).result, "42");
});

test("erc8004.lookup: not registered is an answer, unreachable is an error", async () => {
  const owner0 = fakeClient({ readContract: async (a: { address: string; functionName: string }) => { assert.equal(a.address, ERC8004_IDENTITY_REGISTRY); assert.equal(a.functionName, "balanceOf"); return 0n; } });
  const r1 = await erc8004Lookup({ chain: "base", owner: TX.from }, ctxWith({ client: owner0.client }));
  assert.equal(r1.registered, false);
  assert.equal(r1.balance, "0");

  const missing = fakeClient({ readContract: async () => { throw revert("ERC721NonexistentToken"); } });
  const r2 = await erc8004Lookup({ chain: "base", agent_id: "999999" }, ctxWith({ client: missing.client }));
  assert.equal(r2.registered, false);
  assert.equal(r2.owner, null);

  const found = fakeClient({ readContract: async (a: { functionName: string }) => (a.functionName === "ownerOf" ? TX.from : "ipfs://agent.json") });
  const r3 = await erc8004Lookup({ chain: "ethereum", agent_id: "1" }, ctxWith({ client: found.client }));
  assert.deepEqual([r3.registered, r3.owner, r3.token_uri], [true, TX.from, "ipfs://agent.json"]);

  const down = fakeClient({ readContract: async () => { throw unreachable(); } });
  await assert.rejects(erc8004Lookup({ chain: "base", agent_id: "1" }, ctxWith({ client: down.client })));
  await assert.rejects(erc8004Lookup({ chain: "base" }, ctxWith({ client: down.client })), /exactly one/);
});
