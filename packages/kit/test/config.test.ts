import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FORK_RPC_URL, KitConfigError, loadKitFromEnv, rpcEnvName } from "../src/index.js";

const fakeClient = (url: string) => ({ url }) as any;

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sato-kit-config-"));
}

test("no policy.json → default fork policy, .sato created with a 0600 key, no signer", async () => {
  const cwd = await dir();
  try {
    const l = await loadKitFromEnv({ cwd, env: {}, makeClient: fakeClient });
    assert.equal(l.policyPath, null);
    assert.equal(l.network, "fork");
    assert.equal(l.policy.network, "fork");
    assert.equal(l.signer, null);
    assert.equal(l.rpcUrl("base"), DEFAULT_FORK_RPC_URL);
    const st = await stat(join(cwd, ".sato", "intent.key"));
    assert.equal(st.mode & 0o777, 0o600);
    assert.match((await readFile(join(cwd, ".sato", "intent.key"), "utf8")).trim(), /^[0-9a-f]{64}$/);
    await assert.rejects(l.kit.execute({ intent_id: "si_" + "a".repeat(43) }), /unknown intent_id/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("RPC: opts wins over env, env over the fork default; testnet without a URL names the variable", async () => {
  const cwd = await dir();
  try {
    await writeFile(join(cwd, "policy.json"), JSON.stringify({ schema: "sato.policy/v1", network: "testnet" }));
    const env = { [rpcEnvName("base-sepolia")]: "https://env.example/bs" };
    assert.equal(rpcEnvName("base-sepolia"), "SATO_RPC_URL_BASE_SEPOLIA");
    const l = await loadKitFromEnv({ cwd, env, makeClient: fakeClient });
    assert.equal(l.network, "testnet");
    assert.equal(l.rpcUrl("base-sepolia"), "https://env.example/bs");
    assert.throws(() => l.rpcUrl("sepolia"), /SATO_RPC_URL_SEPOLIA/);
    const l2 = await loadKitFromEnv({ cwd, env, rpc: { "base-sepolia": "https://opt.example" }, makeClient: fakeClient });
    assert.equal(l2.rpcUrl("base-sepolia"), "https://opt.example");
    const l3 = await loadKitFromEnv({ cwd, env, rpc: "https://all.example", network: "fork", makeClient: fakeClient });
    assert.equal(l3.network, "fork");
    assert.equal(l3.rpcUrl("sepolia"), "https://all.example");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("network can only be as permissive as the policy file", async () => {
  const cwd = await dir();
  try {
    await assert.rejects(loadKitFromEnv({ cwd, env: {}, network: "mainnet", makeClient: fakeClient }), KitConfigError);
    await assert.rejects(loadKitFromEnv({ cwd, env: {}, network: "testnet", makeClient: fakeClient }), /policy allows "fork"/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a policy file that does not parse is an error, never the default", async () => {
  const cwd = await dir();
  try {
    await writeFile(join(cwd, "policy.json"), JSON.stringify({ schema: "sato.policy/v1", surprise: 1 }));
    await assert.rejects(loadKitFromEnv({ cwd, env: {}, makeClient: fakeClient }), /unknown property/);
    await assert.rejects(loadKitFromEnv({ cwd, env: {}, policyPath: "missing.json", makeClient: fakeClient }), /cannot read policy file/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("signer: only SATO_SIGNER=viem-local-fork, only on fork", async () => {
  const cwd = await dir();
  try {
    const l = await loadKitFromEnv({ cwd, env: { SATO_SIGNER: "viem-local-fork" }, makeClient: fakeClient });
    assert.equal(l.signer?.kind, "viem-local");
    await assert.rejects(loadKitFromEnv({ cwd, env: { SATO_SIGNER: "cdp" }, makeClient: fakeClient }), /not supported/);
    await writeFile(join(cwd, "policy.json"), JSON.stringify({ schema: "sato.policy/v1", network: "testnet" }));
    await assert.rejects(loadKitFromEnv({ cwd, env: { SATO_SIGNER: "viem-local-fork" }, makeClient: fakeClient }), /fork network only/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
