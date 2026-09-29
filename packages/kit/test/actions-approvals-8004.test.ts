import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, erc20Abi, maxUint256 } from "viem";
import {
  ActionInputError, ERC8004_IDENTITY_REGISTRY, ERC8004_REGISTER_ABI, buildErc8004Register, buildTokenRevoke, simulateTx, tokenApprovalsList,
} from "../src/actions/index.js";
import { evaluatePreflight } from "../src/policy/preflight.js";
import { DEFAULT_POLICY, ctxWith, fakeClient, fixture } from "./fixtures/actions-harness.js";

const REVOKE = fixture("token-revoke.base.json");
const REG = fixture("erc8004-register.base.json");
const OWNER = "0x1111111111111111111111111111111111111111";
const SP1 = "0x2222222222222222222222222222222222222222";
const SP2 = "0x3333333333333333333333333333333333333333";
const NFT = "0x4444444444444444444444444444444444444444";

test("token.approvals.list erc20: one allowance read per named spender, max flagged, coverage stated", async () => {
  const seen: unknown[] = [];
  const { client } = fakeClient({ readContract: async (a: any) => { seen.push(a); return a.args[1] === SP1 ? maxUint256 : 5n; } });
  const out = await tokenApprovalsList({ chain: "base", owner: OWNER, token: REVOKE.token, spenders: [SP1, SP2] }, ctxWith({ client }));
  assert.equal(out.kind, "erc20");
  assert.deepEqual(out.approvals, [
    { spender: SP1, allowance: maxUint256.toString(), is_max_uint256: true, approved_for_all: null },
    { spender: SP2, allowance: "5", is_max_uint256: false, approved_for_all: null },
  ]);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((a: any) => a.functionName === "allowance"));
  assert.match(out.coverage, /Only the 2 spender/);
});

test("token.approvals.list erc721/erc1155: operator approval for all", async () => {
  for (const kind of ["erc721", "erc1155"]) {
    const { client } = fakeClient({ readContract: async (a: any) => { assert.equal(a.functionName, "isApprovedForAll"); return a.args[1] === SP1; } });
    const out = await tokenApprovalsList({ chain: "ethereum", owner: OWNER, token: NFT, kind, spenders: [SP1, SP2] }, ctxWith({ client }));
    assert.deepEqual(out.approvals.map((r) => r.approved_for_all), [true, false]);
    assert.ok(out.approvals.every((r) => r.allowance === null && r.is_max_uint256 === null));
  }
});

test("token.approvals.list refuses bad input", async () => {
  await assert.rejects(tokenApprovalsList({ chain: "base", owner: OWNER, token: NFT, spenders: [] }, ctxWith()), ActionInputError);
  await assert.rejects(tokenApprovalsList({ chain: "base", owner: OWNER, token: NFT, spenders: [SP1], kind: "erc777" }, ctxWith()), ActionInputError);
  await assert.rejects(tokenApprovalsList({ chain: "solana", owner: OWNER, token: NFT, spenders: [SP1] }, ctxWith()), ActionInputError);
});

test("token.approvals.revoke erc20: approve(spender, 0) matches the recorded fork fixture; facts name token + spender", async () => {
  const { client } = fakeClient({ readContract: async () => 7n });
  const b = await buildTokenRevoke({ chain: "base", owner: REVOKE.owner, token: REVOKE.token, spender: REVOKE.spender }, ctxWith({ client }));
  assert.equal(b.unsigned.kind, "evm_tx");
  const u = b.unsigned as any;
  assert.equal(u.to, REVOKE.token);
  assert.equal(u.data, REVOKE.tx.data);
  assert.equal(u.value, "0");
  assert.equal(u.chain_id, 8453);
  const d = decodeFunctionData({ abi: erc20Abi, data: u.data });
  assert.equal(d.functionName, "approve");
  assert.deepEqual(d.args, [REVOKE.spender, 0n]);
  assert.equal(b.facts.contract, REVOKE.token);
  assert.equal(b.facts.token, REVOKE.token);
  assert.equal((b.facts as any).spender, REVOKE.spender);
  assert.equal(b.facts.usd_value, 0);
  assert.match(b.summary, /Current approval: 7 base units/);
  assert.equal(b.fee_disclosure, null);
});

test("token.approvals.revoke erc721: setApprovalForAll(operator, false); unreadable current approval is stated", async () => {
  const b = await buildTokenRevoke({ chain: "base", owner: OWNER, token: NFT, spender: SP1, kind: "erc721" }, ctxWith());
  const d = decodeFunctionData({
    abi: [{ type: "function", name: "setApprovalForAll", stateMutability: "nonpayable", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] }] as const,
    data: (b.unsigned as any).data,
  });
  assert.deepEqual(d.args, [SP1, false]);
  assert.match(b.summary, /could not be read/);
});

test("revoke replays through simulate + pre-flight from the recorded eth_call", async () => {
  const { client } = fakeClient({
    readContract: async () => 0n,
    getBlockNumber: async () => BigInt(REVOKE.block),
    call: async () => ({ data: REVOKE.eth_call.result }),
    estimateGas: async () => BigInt(REVOKE.estimate_gas),
  });
  const ctx = ctxWith({ client });
  const b = await buildTokenRevoke({ chain: "base", owner: REVOKE.owner, token: REVOKE.token, spender: REVOKE.spender }, ctx);
  const sim = await simulateTx(b.unsigned as any, ctx);
  assert.equal(sim.ok, true);
  const pf = evaluatePreflight({ ...DEFAULT_POLICY, network: "mainnet" }, { ...b.facts, simulation: sim, ttl_s: 60 });
  assert.equal(pf.ok, true, JSON.stringify(pf.refusals));
  const blocked = evaluatePreflight({ ...DEFAULT_POLICY, network: "mainnet", allow_contracts: ["base:0x0000000000000000000000000000000000000001"] }, { ...b.facts, simulation: sim, ttl_s: 60 });
  assert.ok(blocked.refusals.some((r) => r.rule === "contract_allowlist" && r.observed === `base:${REVOKE.token}`));
});

test("erc8004.register: register(agentURI) on the registry, byte-identical to the recorded fixture", async () => {
  const b = await buildErc8004Register({ chain: "base", owner: REG.from, agent_uri: REG.agent_uri }, ctxWith());
  const u = b.unsigned as any;
  assert.equal(u.to, ERC8004_IDENTITY_REGISTRY);
  assert.equal(u.to, REG.registry);
  assert.equal(u.data, REG.tx.data);
  assert.equal(u.value, "0");
  assert.deepEqual(decodeFunctionData({ abi: ERC8004_REGISTER_ABI, data: u.data }).args, [REG.agent_uri]);
  assert.equal(b.facts.contract, ERC8004_IDENTITY_REGISTRY);
  assert.equal(b.fee_disclosure, null);
});

test("erc8004.register replays through simulate from the recorded eth_call", async () => {
  const { client } = fakeClient({
    getBlockNumber: async () => BigInt(REG.block),
    call: async () => ({ data: REG.eth_call.result }),
    estimateGas: async () => BigInt(REG.estimate_gas),
  });
  const ctx = ctxWith({ client });
  const b = await buildErc8004Register({ chain: "base", owner: REG.from, agent_uri: REG.agent_uri }, ctx);
  const sim = await simulateTx(b.unsigned as any, ctx);
  assert.equal(sim.ok, true);
});

test("erc8004.register refuses chains without a deployed registry and bad URIs", async () => {
  for (const chain of ["sepolia", "base-sepolia", "solana"]) {
    await assert.rejects(buildErc8004Register({ chain, owner: OWNER, agent_uri: "https://x.y/a.json" }, ctxWith()), /no ERC-8004 Identity Registry is deployed/);
  }
  for (const agent_uri of ["", "   ", "https://a b", "x".repeat(2049), 5]) {
    await assert.rejects(buildErc8004Register({ chain: "base", owner: OWNER, agent_uri }, ctxWith()), ActionInputError);
  }
});
