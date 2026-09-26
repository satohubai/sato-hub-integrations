import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, custom, keccak256, parseTransaction, recoverTransactionAddress, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { viemLocalSigner, cdpSigner, owsSigner, humanApprove, ApprovalRefusedError } from "../src/signers/index.js";
import type { UnsignedEvmTx } from "../src/spec/index.js";
import type { RpcProvider, Signer, TypedDataInput } from "../src/types.js";

// Anvil's well-known dev key #0 (public test key, never funded on any real chain).
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function mockRpc(chainId: number) {
  const sent: string[] = [];
  const request = async ({ method, params }: { method: string; params?: any[] }) => {
    switch (method) {
      case "eth_chainId": return "0x" + chainId.toString(16);
      case "eth_getTransactionCount": return "0x0";
      case "eth_estimateGas": return "0x5208";
      case "eth_gasPrice": return "0x3b9aca00";
      case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x3b9aca00", number: "0x1", hash: "0x" + "11".repeat(32), timestamp: "0x1", transactions: [] };
      case "eth_sendRawTransaction": sent.push(params![0]); return keccak256(params![0]);
      default: throw Object.assign(new Error("mock rpc: method not found " + method), { code: -32601 });
    }
  };
  const client = createPublicClient({ transport: custom({ request }) }) as PublicClient;
  const rpc: RpcProvider = () => client;
  return { rpc, sent };
}

const tx = (chain_id: number, from: string | null = null): UnsignedEvmTx =>
  ({ kind: "evm_tx", chain: "base-sepolia", chain_id, from, to: TO, data: "0x", value: "1000" });

test("viem-local signs a tx for anvil 31337 over a mocked transport", async () => {
  const { rpc, sent } = mockRpc(31337);
  const s = viemLocalSigner({ privateKey: TEST_KEY, rpc });
  const addr = privateKeyToAccount(TEST_KEY).address;
  assert.equal(s.kind, "viem-local");
  assert.equal(await s.address("base-sepolia"), addr);
  const { tx_hash } = await s.sendTransaction(tx(31337, addr));
  assert.equal(sent.length, 1);
  assert.equal(tx_hash, keccak256(sent[0] as `0x${string}`));
  const parsed = parseTransaction(sent[0] as `0x${string}`);
  assert.equal(parsed.chainId, 31337);
  assert.equal(parsed.value, 1000n);
  assert.equal(parsed.to?.toLowerCase(), TO.toLowerCase());
  assert.equal(await recoverTransactionAddress({ serializedTransaction: sent[0] as any }), addr);
});

test("viem-local refuses mainnet chain ids", async () => {
  for (const id of [1, 10, 137, 8453, 42161]) {
    const { rpc, sent } = mockRpc(id);
    const s = viemLocalSigner({ privateKey: TEST_KEY, rpc });
    await assert.rejects(s.sendTransaction(tx(id)), /refusing chain id/);
    assert.equal(sent.length, 0);
  }
  const { rpc } = mockRpc(8453);
  const s = viemLocalSigner({ privateKey: TEST_KEY, rpc });
  const td: TypedDataInput = { domain: { name: "x", chainId: 8453 }, types: { M: [{ name: "a", type: "uint256" }] }, primaryType: "M", message: { a: 1 } };
  await assert.rejects(s.signTypedData(td), /refusing chain id/);
});

test("viem-local refuses an RPC whose chain id differs from the tx", async () => {
  const { rpc, sent } = mockRpc(1);
  const s = viemLocalSigner({ privateKey: TEST_KEY, rpc });
  await assert.rejects(s.sendTransaction(tx(31337)), /does not match/);
  assert.equal(sent.length, 0);
});

test("viem-local allowMainnet lets a mainnet id through (not recommended)", async () => {
  const { rpc, sent } = mockRpc(8453);
  const s = viemLocalSigner({ privateKey: TEST_KEY, rpc, allowMainnet: true });
  await s.sendTransaction(tx(8453));
  assert.equal(sent.length, 1);
});

test("viem-local refuses a tx.from that is not its address", async () => {
  const { rpc } = mockRpc(31337);
  const s = viemLocalSigner({ privateKey: TEST_KEY, rpc });
  await assert.rejects(s.sendTransaction(tx(31337, TO)), /not this signer's address/);
});

test("viem-local generate:true yields different in-memory keys", async () => {
  const { rpc } = mockRpc(31337);
  const a = await viemLocalSigner({ generate: true, rpc }).address("base-sepolia");
  const b = await viemLocalSigner({ generate: true, rpc }).address("base-sepolia");
  assert.match(a, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(a, b);
});

test("viem-local signTypedData matches viem", async () => {
  const { rpc } = mockRpc(31337);
  const td: TypedDataInput = { domain: { name: "x", chainId: 31337 }, types: { M: [{ name: "a", type: "uint256" }] }, primaryType: "M", message: { a: 1n } };
  const sig = await viemLocalSigner({ privateKey: TEST_KEY, rpc }).signTypedData(td);
  assert.equal(sig, await privateKeyToAccount(TEST_KEY).signTypedData(td as any));
});

test("cdp adapter delegates to the account and carries nativePolicy", async () => {
  const calls: any[] = [];
  const account = {
    address: "0x1111111111111111111111111111111111111111" as const,
    async sendTransaction(args: any) { calls.push(["send", args]); return { transactionHash: ("0x" + "ab".repeat(32)) as `0x${string}` }; },
    async signTypedData(args: any) { calls.push(["sign", args]); return "0xdead" as `0x${string}`; },
  };
  const s = cdpSigner({ account, nativePolicy: { rules: [] } });
  assert.equal(s.kind, "cdp");
  assert.deepEqual(s.nativePolicy, { format: "cdp", document: { rules: [] } });
  assert.equal(await s.address("base"), account.address);
  const r = await s.sendTransaction(tx(84532));
  assert.equal(r.tx_hash, "0x" + "ab".repeat(32));
  assert.equal(calls[0][1].network, "base-sepolia");
  assert.equal(calls[0][1].transaction.value, 1000n);
  assert.equal(await s.signTypedData({ domain: {}, types: {}, primaryType: "M", message: {} }), "0xdead");
  assert.equal(calls.length, 2);
  assert.throws(() => cdpSigner({ account: {} }), /CDP EVM account/);
});

test("ows adapter delegates typed data to the injected account", async () => {
  const acct = privateKeyToAccount(TEST_KEY);
  const s = owsSigner({ wallet: acct, nativePolicy: { id: "p" } });
  assert.equal(s.kind, "ows");
  assert.equal(s.nativePolicy?.format, "ows");
  const td: TypedDataInput = { domain: { name: "x" }, types: { M: [{ name: "a", type: "uint256" }] }, primaryType: "M", message: { a: 2n } };
  assert.equal(await s.signTypedData(td), await acct.signTypedData(td as any));
  const { rpc, sent } = mockRpc(31337);
  await owsSigner({ wallet: acct, rpc }).sendTransaction(tx(31337));
  assert.equal(sent.length, 1);
  assert.throws(() => owsSigner({ wallet: {} }), /OWS-backed/);
});

test("humanApprove refuses unless approve() resolves true", async () => {
  let inner = 0;
  const base: Signer = {
    kind: "viem-local",
    address: async () => "0x1111111111111111111111111111111111111111",
    sendTransaction: async () => { inner++; return { tx_hash: ("0x" + "cd".repeat(32)) as `0x${string}` }; },
    signTypedData: async () => { inner++; return "0xbeef" as `0x${string}`; },
  };
  const td: TypedDataInput = { domain: {}, types: {}, primaryType: "M", message: {} };
  const no = humanApprove(base, async () => false);
  assert.equal(no.kind, "human-approve");
  await assert.rejects(no.sendTransaction(tx(31337)), ApprovalRefusedError);
  await assert.rejects(no.signTypedData(td), ApprovalRefusedError);
  await assert.rejects(humanApprove(base, async () => { throw new Error("x"); }).sendTransaction(tx(31337)), ApprovalRefusedError);
  await assert.rejects(humanApprove(base, async () => "yes" as any).sendTransaction(tx(31337)), ApprovalRefusedError);
  assert.equal(inner, 0);
  const seen: any[] = [];
  const yes = humanApprove(base, async (s) => { seen.push(s); return true; });
  await yes.sendTransaction(tx(31337));
  assert.equal(await yes.signTypedData(td), "0xbeef");
  assert.equal(inner, 2);
  assert.equal(seen[0].kind, "evm_tx");
  assert.equal(seen[1].kind, "typed_data");
});
