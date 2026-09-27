// CLI builder. Spawns the built CLI (.test-build/src/cli/main.js) the way a
// user runs `npx sato-kit`. Offline and deterministic: a --import preload
// replaces globalThis.fetch in the child with recorded answers (JSON-RPC, an
// x402 402 body, a Sato Status document), so nothing leaves the machine and
// no server is started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // .test-build/test
const MAIN = resolve(HERE, "../src/cli/main.js");
const PKG = resolve(HERE, "../..");
const X402_V1 = JSON.parse(readFileSync(join(PKG, "test/fixtures/x402-v1-body.json"), "utf8"));

const STATUS_DOC = {
  schema: "sato.action-status/v1",
  updated: "2026-09-26",
  actions: [
    { id: "sato-kit:chain.read", name: "chain_read", result: "green", last_green: "2026-09-26", failing_step: null, upstream_version: "0.1.0" },
    { id: "sato-kit:swap.quote", name: "swap_quote", result: "red", last_green: "2026-09-20", failing_step: "conformance", upstream_version: "0.1.0" },
  ],
};

// The preload: a fetch stand-in keyed on URL. It is plain JS written at test time.
const PRELOAD = `
const x402 = ${JSON.stringify(X402_V1)};
const status = ${JSON.stringify(STATUS_DOC)};
const mode = process.env.CLI_TEST_STATUS ?? "ok";
function rpc(m) {
  switch (m.method) {
    case "eth_chainId": return "0x2105";
    case "eth_blockNumber": return "0x1234";
    case "eth_getBalance": return "0xde0b6b3a7640000";
    default: return null;
  }
}
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("http://rpc.fixture")) {
    const body = JSON.parse(init.body);
    const one = (m) => ({ jsonrpc: "2.0", id: m.id, result: rpc(m) });
    const out = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === "https://paid.fixture/data") return new Response(JSON.stringify(x402), { status: 402, headers: { "content-type": "application/json" } });
  if (url.endsWith("/actions-status.json")) {
    if (mode === "down") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(status), { status: 200 });
  }
  throw new TypeError("offline test: no fixture for " + url);
};
`;

const TMP = mkdtempSync(join(tmpdir(), "sato-kit-cli-"));
const PRELOAD_FILE = join(TMP, "fixture-fetch.mjs");
writeFileSync(PRELOAD_FILE, PRELOAD);

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const cwd = opts.cwd ?? mkdtempSync(join(TMP, "w-"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: TMP, SATO_RPC_URL_BASE: "http://rpc.fixture/base", ...opts.env };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(PRELOAD_FILE).href, MAIN, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0, cwd };
}

function json(out: string): any {
  return JSON.parse(out.trim().split("\n").pop()!);
}

test("--help exits 0 in under 10 s, and is short", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms < 10_000, `cold start took ${r.ms} ms`);
  assert.match(r.stdout, /sato-kit read <action>/);
  assert.match(r.stdout, /execute --intent <intent_id>/);
  assert.ok(r.stdout.split("\n").length <= 25, "help stays short");
  assert.doesNotMatch(r.stdout, /\b(safe|secure|guaranteed|best)\b/i);
});

test("no command is a usage error (exit 1)", () => {
  const r = run(["--json"]);
  assert.equal(r.code, 1);
  assert.equal(json(r.stdout).error.code, "usage");
});

test("read chain_read against a fixture RPC → JSON ok", () => {
  const r = run(["read", "chain_read", "--input", JSON.stringify({ kind: "native_balance", chain: "base", address: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" }), "--json"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const o = json(r.stdout);
  assert.equal(o.ok, true);
  assert.equal(o.command, "read");
  assert.equal(o.action, "chain.read");
  assert.equal(o.result.kind, "native_balance");
  assert.equal(o.result.result, "1000000000000000000");
});

test("the ODA id works as well as the tool name", () => {
  const r = run(["read", "chain.read", "--input", JSON.stringify({ kind: "block_number", chain: "base" }), "--json"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(json(r.stdout).action, "chain.read");
});

test("read of a prepare action is refused with a pointer to prepare", () => {
  const r = run(["read", "x402_prepare", "--input", "{}", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(json(r.stdout).error.code, "wrong_command");
  assert.match(json(r.stdout).error.message, /sato-kit prepare x402_prepare/);
});

test("prepare over the cap → exit 2 with refusals naming rule/limit/observed", () => {
  const r = run(["prepare", "x402_prepare", "--input", JSON.stringify({ url: "https://paid.fixture/data", max_amount_base_units: "100" }), "--json"]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  const o = json(r.stdout);
  assert.equal(o.ok, false);
  assert.equal(o.command, "prepare");
  assert.equal(o.error.code, "refused");
  const cap = o.error.refusals.find((x: any) => x.rule === "max_per_trade");
  assert.ok(cap, JSON.stringify(o.error.refusals));
  assert.equal(cap.limit, "100");
  assert.equal(cap.observed, "50000");
});

test("prepare over the cap without --json prints the refusal to stderr, exit 2", () => {
  const r = run(["prepare", "x402.prepare", "--input", JSON.stringify({ url: "https://paid.fixture/data", max_amount_base_units: "100" })]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /max_per_trade \(limit 100, observed 50000\)/);
});

test("execute takes only --intent: --to is an error that names it (exit 1)", () => {
  const r = run(["execute", "--intent", "si_x", "--to", "0xabc", "--json"]);
  assert.equal(r.code, 1);
  const o = json(r.stdout);
  assert.equal(o.ok, false);
  assert.equal(o.command, "execute");
  assert.match(o.error.message, /--to/);
  const r2 = run(["execute", "--intent", "si_x", "--policy", "p.json", "--json"]);
  assert.equal(r2.code, 1);
  assert.match(json(r2.stdout).error.message, /--policy/);
});

test("execute of an unknown intent is an error (exit 1)", () => {
  const r = run(["execute", "--intent", "si_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "--json"]);
  assert.equal(r.code, 1, r.stdout);
  assert.equal(json(r.stdout).ok, false);
});

test("doctor --json shape: versions, policy, signer, network, per-action status", () => {
  const r = run(["doctor", "--json"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const o = json(r.stdout);
  assert.equal(o.ok, true);
  assert.equal(o.command, "doctor");
  const d = o.result;
  assert.equal(d.kit_version, "0.1.0");
  assert.match(d.node_version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(d.policy, { valid: true, path: null, source: "default" });
  assert.equal(d.network, "fork");
  assert.deepEqual(d.signer, { configured: false });
  assert.equal(d.status_source, "reachable");
  const cr = d.actions.find((a: any) => a.id === "chain.read");
  assert.deepEqual(cr, { id: "chain.read", name: "chain_read", result: "green", last_green: "2026-09-26" });
  const sq = d.actions.find((a: any) => a.id === "swap.quote");
  assert.equal(sq.result, "red");
  assert.equal(sq.failing_step, "conformance");
  assert.equal(sq.upstream_version, "0.1.0");
  assert.equal(d.actions.find((a: any) => a.id === "x402.prepare").result, "not_listed");
  // Only core actions; no meta tools.
  assert.ok(!d.actions.some((a: any) => a.name === "execute" || a.name === "status"));
});

test("doctor: Sato Status unreachable → unknown with a reason, never invented", () => {
  const r = run(["doctor", "--json"], { env: { CLI_TEST_STATUS: "down" } });
  assert.equal(r.code, 0);
  const d = json(r.stdout).result;
  assert.equal(d.status_source, "unreachable");
  assert.match(d.status_reason, /could not be read/);
  assert.ok(d.actions.every((a: any) => a.result === "unknown" && !("last_green" in a)));
});

test("doctor: an invalid policy.json is reported, not replaced by the default", () => {
  const cwd = mkdtempSync(join(TMP, "bad-"));
  writeFileSync(join(cwd, "policy.json"), "{ not json");
  const r = run(["doctor", "--json"], { cwd });
  assert.equal(r.code, 0);
  const d = json(r.stdout).result;
  assert.equal(d.policy.valid, false);
  assert.match(d.policy.error, /not valid JSON/);
  assert.equal(d.network, null);
});

test("mcp subcommand", { skip: "runStdio is a stub on m1/kit-skeleton; enable once the MCP builder's src/mcp merges" }, () => {
  const r = run(["mcp", "--toolsets", "all"]);
  assert.equal(r.code, 0);
});

test("mcp rejects a bad --toolsets before starting", () => {
  const r = run(["mcp", "--toolsets", "most", "--json"]);
  assert.equal(r.code, 1);
  assert.match(json(r.stdout).error.message, /--toolsets/);
});
