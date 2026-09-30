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

const DRIFT_DOC = {
  schema: "sato.template-drift/v1",
  template: { id: "base-guarded-trader", framework: "plain-ts", pinned_version: "0.1.0", pinned_digest: "sha256:aaa", latest_version: "0.2.0", latest_digest: "sha256:bbb", latest_last_green: "2026-09-27" },
  changes: [
    { key: "template:base-guarded-trader/plain-ts@sha256:bbb", kind: "template_update", title: "base-guarded-trader/plain-ts 0.2.0 is available", body_markdown: "Update with the command shown.", evidence_urls: ["https://github.com/satohubai/sato-agent-templates/commit/bbb"] },
    { key: "broken:viem@2.56.9", kind: "upstream_break", title: "viem 2.56.9 fails the template checks", body_markdown: "See the run.", evidence_urls: ["https://github.com/satohubai/sato-agent-templates/actions/runs/1"] },
  ],
};

// The preload: a fetch stand-in keyed on URL. It is plain JS written at test time.
const PRELOAD = `
const x402 = ${JSON.stringify(X402_V1)};
const status = ${JSON.stringify(STATUS_DOC)};
const mode = process.env.CLI_TEST_STATUS ?? "ok";
const drift = ${JSON.stringify(DRIFT_DOC)};
const driftMode = process.env.CLI_TEST_DRIFT ?? "ok";
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
  if (url === "https://satohub.ai/api/create/drift") {
    if (process.env.CLI_TEST_DRIFT_LOG) (await import("node:fs")).writeFileSync(process.env.CLI_TEST_DRIFT_LOG, JSON.stringify({ method: init.method, headers: init.headers, body: JSON.parse(init.body), hasSignal: !!init.signal }));
    if (driftMode === "down") throw new TypeError("fetch failed");
    if (driftMode === "hang") return await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    if (driftMode === "http429") return new Response("slow down", { status: 429 });
    if (driftMode === "badshape") return new Response(JSON.stringify({ schema: "sato.template-drift/v1", template: drift.template, changes: [{ key: "x", kind: "unsafe", title: "t", body_markdown: "", evidence_urls: [] }] }), { status: 200 });
    return new Response(JSON.stringify(drift), { status: 200 });
  }
  if (url.endsWith("/actions-status.json")) {
    if (mode === "down") throw new TypeError("fetch failed");
    const onStatusBranch = url.includes("/sato-agent-templates/status/");
    if (onStatusBranch && mode === "status404") return new Response("404: Not Found", { status: 404 });
    if (onStatusBranch && mode === "status500") return new Response("oops", { status: 500 });
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
  assert.equal(d.kit_version, "0.1.1");
  assert.match(d.node_version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(d.policy, { valid: true, path: null, source: "default" });
  assert.equal(d.network, "fork");
  assert.deepEqual(d.signer, { configured: false });
  assert.equal(d.status_source, "reachable");
  assert.equal(d.status_answered_by, "status-branch");
  assert.match(d.status_url, /sato-agent-templates\/status\/actions-status\.json$/);
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

test("doctor: status branch 404 → reads the frozen main copy and says so", () => {
  const d = json(run(["doctor", "--json"], { env: { CLI_TEST_STATUS: "status404" } }).stdout).result;
  assert.equal(d.status_source, "reachable");
  assert.equal(d.status_answered_by, "main-fallback");
  assert.match(d.status_url, /sato-agent-templates\/main\/actions-status\.json$/);
});

test("doctor: status branch 500 → unreachable, never silently the main copy", () => {
  const d = json(run(["doctor", "--json"], { env: { CLI_TEST_STATUS: "status500" } }).stdout).result;
  assert.equal(d.status_source, "unreachable");
  assert.equal(d.status_answered_by, null);
  assert.match(d.status_reason, /HTTP 500/);
  assert.ok(d.actions.every((a: any) => a.result === "unknown"));
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

function generatedRepo(): string {
  const cwd = mkdtempSync(join(TMP, "gen-"));
  writeFileSync(join(cwd, "sato.create.json"), JSON.stringify({ template: "base-guarded-trader", framework: "plain-ts", version: "0.1.0" }));
  writeFileSync(join(cwd, "sato.lock.json"), JSON.stringify({ packages: { viem: "2.56.9" } }));
  return cwd;
}

test("doctor: no sato.create.json → drift not checked, and no request is made", () => {
  const log = join(mkdtempSync(join(TMP, "log-")), "drift.json");
  const d = json(run(["doctor", "--json"], { env: { CLI_TEST_DRIFT_LOG: log } }).stdout).result;
  assert.equal(d.drift.state, "not_applicable");
  assert.match(d.drift.reason, /no sato\.create\.json/);
  assert.throws(() => readFileSync(log, "utf8"));
});

test("doctor: a generated repo → POSTs both files and prints the changes the endpoint returned", () => {
  const cwd = generatedRepo();
  const log = join(cwd, "..", "drift-log-" + Date.now() + ".json");
  const r = run(["doctor", "--json"], { cwd, env: { CLI_TEST_DRIFT_LOG: log } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const d = json(r.stdout).result.drift;
  assert.equal(d.state, "checked");
  assert.equal(d.url, "https://satohub.ai/api/create/drift");
  assert.deepEqual(d.template, DRIFT_DOC.template);
  assert.deepEqual(d.changes, DRIFT_DOC.changes);
  const sent = JSON.parse(readFileSync(log, "utf8"));
  assert.equal(sent.method, "POST");
  assert.equal(sent.hasSignal, true);
  assert.match(sent.headers["user-agent"], /^@satohub\/kit\//);
  assert.deepEqual(sent.body, { create: { template: "base-guarded-trader", framework: "plain-ts", version: "0.1.0" }, lock: { packages: { viem: "2.56.9" } } });
});

test("doctor human output lists each drift change with its evidence", () => {
  const r = run(["doctor"], { cwd: generatedRepo() });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Template drift: base-guarded-trader\/plain-ts pinned 0\.1\.0, latest 0\.2\.0 \(last passed its checks 2026-09-27\) — 2 changes/);
  assert.match(r.stdout, /\[template_update\] base-guarded-trader\/plain-ts 0\.2\.0 is available/);
  assert.match(r.stdout, /\[upstream_break\] viem 2\.56\.9 fails the template checks/);
  assert.match(r.stdout, /evidence: https:\/\/github\.com\/satohubai\/sato-agent-templates\/actions\/runs\/1/);
  // Action ids (safe.info / safe.propose name the Safe product) are identifiers, not claims.
  assert.doesNotMatch(r.stdout.replace(/\bsafe\.(info|propose)\b/g, ""), /\b(safe|unsafe|secure|guaranteed|best)\b/i);
});

for (const [mode, re] of [["down", /could not be read/], ["http429", /HTTP 429/], ["badshape", /did not return a sato\.template-drift\/v1 document/]] as const) {
  test(`doctor: drift ${mode} → unavailable with a reason, no changes invented`, () => {
    const d = json(run(["doctor", "--json"], { cwd: generatedRepo(), env: { CLI_TEST_DRIFT: mode } }).stdout).result.drift;
    assert.equal(d.state, "unavailable");
    assert.match(d.reason, re);
    assert.ok(!("changes" in d));
  });
}

test("doctor: drift that does not answer is cut off at 3 s", () => {
  const t0 = Date.now();
  const r = run(["doctor", "--json"], { cwd: generatedRepo(), env: { CLI_TEST_DRIFT: "hang" } });
  const d = json(r.stdout).result.drift;
  assert.equal(d.state, "unavailable");
  assert.match(d.reason, /did not answer within 3 s/);
  assert.ok(Date.now() - t0 < 10_000);
});

test("doctor: sato.create.json without sato.lock.json → unavailable, no request", () => {
  const cwd = mkdtempSync(join(TMP, "nolock-"));
  writeFileSync(join(cwd, "sato.create.json"), "{}");
  const log = join(cwd, "..", "nolock-log-" + Date.now() + ".json");
  const d = json(run(["doctor", "--json"], { cwd, env: { CLI_TEST_DRIFT_LOG: log } }).stdout).result.drift;
  assert.equal(d.state, "unavailable");
  assert.match(d.reason, /sato\.lock\.json is missing/);
  assert.throws(() => readFileSync(log, "utf8"));
});

test("mcp subcommand: answers initialize in under 10 s and exits 0 when stdin closes", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const cwd = mkdtempSync(join(TMP, "mcp-"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: TMP, SATO_RPC_URL_BASE: "http://rpc.fixture/base" };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(PRELOAD_FILE).href, MAIN, "mcp", "--toolsets", "all"], {
    cwd, env, encoding: "utf8", timeout: 20_000,
    input: JSON.stringify(init) + "\n" + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" + JSON.stringify(list) + "\n",
  });
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 10_000, `mcp cold start + session took ${ms} ms`);
  const msgs = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(msgs.find((m) => m.id === 1).result.serverInfo.name, "sato-kit");
  const names = msgs.find((m) => m.id === 2).result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes("erc8004_lookup") && names.includes("tx_simulate"));
});

test("mcp rejects a bad --toolsets before starting", () => {
  const r = run(["mcp", "--toolsets", "most", "--json"]);
  assert.equal(r.code, 1);
  assert.match(json(r.stdout).error.message, /--toolsets/);
});
