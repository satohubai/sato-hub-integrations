// The Sato OS hand-off against an in-test fake Sato OS built from the real
// route shapes (sato_os/app/api/os/agents/attach + /api/os/mcp). Offline;
// the server listens on 127.0.0.1:0 and is closed after the suite.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { attachToSatoOs, proposeIntent, readSatoOsConfig, proposalArguments, SatoOsError, SATO_OS_PROPOSAL_TOOL } from "../src/sato-os/index.js";
import type { PreparedIntent } from "../src/spec/index.js";
import { KIT_USER_AGENT } from "../src/version.js";

const TOKEN = "sato_os_testtoken_0123456789abcdef";
type Seen = { path: string; headers: IncomingMessage["headers"]; body: any };
const seen: Seen[] = [];
let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/api/os/agents/attach" && req.method === "POST") {
        if (String(body.goal ?? "").trim().length < 12) return send(400, { ok: false, error: "Describe what the agent does (12+ characters).", fields: { goal: "x" } });
        return send(201, {
          ok: true,
          data: {
            agent: { id: "agt-1", slug: "demo", open_at: "/os/agents/agt-1" },
            wallets: [],
            passportImported: false,
            apiToken: body.issueToken === true ? TOKEN : null,
            mcpEndpoint: "/api/os/mcp",
          },
        });
      }
      if (req.url === "/api/os/mcp" && req.method === "POST") {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          return send(401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Invalid, revoked, or expired API token." } });
        }
        if (body.method !== "tools/call" || body.params?.name !== SATO_OS_PROPOSAL_TOOL) {
          return send(200, { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Unknown tool: ${body.params?.name}` } });
        }
        const a = body.params.arguments;
        for (const k of ["intentType", "chain", "humanSummary", "agentReason"]) {
          if (!a[k]) return send(200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "{}" }], structuredContent: { error: `${k} is required.` } } });
        }
        const out = { intentId: "int-42", approvalId: "apr-7", policy: { ok: true }, status: "pending_approval", tier: "APPROVAL", tier_note: "Waits in the human approval queue." };
        return send(200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out } });
      }
      send(404, { ok: false, error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const NOW = Date.parse("2026-09-28T12:00:00Z");
function intent(over: Partial<PreparedIntent> = {}): PreparedIntent {
  return {
    intent_id: "sha256:abc",
    action: "sato.swap",
    expires_at: "2026-09-28T12:10:00Z",
    summary: "Swap 5 USDC for WETH on Base via venue X.",
    policy: { ok: true, refusals: [] },
    simulation: { ok: true, method: "eth_call", block: "123", gas_estimate: "150000", error: null, as_of: "2026-09-28T12:00:00Z" },
    fee_disclosure: { venue: "x", fee_bps: 0, fee_recipient: null, statement: "no fee", direct_quote_available: true },
    unsigned: { kind: "evm_tx", chain: "base", chain_id: 8453, from: null, to: "0x0000000000000000000000000000000000000001", data: "0xdeadbeef", value: "0" },
    ...over,
  };
}

test("attach: real body shape, token persisted 0600 + gitignored, never returned", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "satoos-")), ".sato");
  const r = await attachToSatoOs({ baseUrl: base + "/", name: "demo", goal: "Swaps small amounts on Base", walletAddresses: ["0x0000000000000000000000000000000000000002"], chains: ["base"], dir, clock: () => NOW });
  assert.equal(r.agent_id, "agt-1");
  assert.ok(!JSON.stringify(r).includes(TOKEN), "token must not be in the result");
  const req = seen.at(-1)!;
  assert.equal(req.path, "/api/os/agents/attach");
  assert.equal(req.body.issueToken, true);
  assert.deepEqual(req.body.chains, ["base"]);
  assert.equal(req.headers["user-agent"], KIT_USER_AGENT);
  const st = await stat(join(dir, "sato-os.json"));
  assert.equal(st.mode & 0o777, 0o600);
  assert.match(await readFile(join(dir, ".gitignore"), "utf8"), /^sato-os\.json$/m);
  const cfg = await readSatoOsConfig(dir);
  assert.equal(cfg.token, TOKEN);
  assert.equal(cfg.base_url, base);
  await assert.rejects(attachToSatoOs({ baseUrl: base, name: "demo", goal: "Swaps small amounts on Base", walletAddresses: ["0x0000000000000000000000000000000000000002"], chains: ["base"], dir }), (e: unknown) => e instanceof SatoOsError && e.code === "config");
});

test("attach: a Sato OS validation error surfaces with its message and nothing is written", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "satoos-")), ".sato");
  await assert.rejects(attachToSatoOs({ baseUrl: base, name: "demo", goal: "short", walletAddresses: ["0x0000000000000000000000000000000000000002"], chains: ["base"], dir }), (e: unknown) => e instanceof SatoOsError && e.status === 400 && /12\+ characters/.test(e.message));
  await assert.rejects(readdir(dir));
});

test("propose: files the intent through the real proposal tool with bearer + UA", async () => {
  const r = await proposeIntent(intent(), { baseUrl: base, token: TOKEN, agentId: "agt-1", clock: () => NOW });
  assert.deepEqual(r, { proposal_id: "int-42", status: "pending_approval", approval_id: "apr-7", tier: "APPROVAL" });
  const req = seen.at(-1)!;
  assert.equal(req.path, "/api/os/mcp");
  assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(req.headers["user-agent"], KIT_USER_AGENT);
  assert.equal(req.body.params.name, "sato_os_create_action_proposal");
  const a = req.body.params.arguments;
  assert.equal(a.intentType, "call_contract");
  assert.equal(a.chain, "base");
  assert.equal(a.agentId, "agt-1");
  const reason = JSON.parse(a.agentReason);
  assert.deepEqual(reason.unsigned, intent().unsigned);
  assert.ok(reason.simulation && reason.fee_disclosure && reason.policy);
});

test("propose: x402 intents map to x402_payment with the resource URL", () => {
  const a = proposalArguments(intent({ unsigned: { kind: "x402_payment", network: "base", resource: "https://api.example/paid", pay_to: "0x0000000000000000000000000000000000000003", asset: "0x0000000000000000000000000000000000000004", amount: "10000" } }));
  assert.equal(a.intentType, "x402_payment");
  assert.equal(a.x402Url, "https://api.example/paid");
  assert.equal(a.targetAddress, "0x0000000000000000000000000000000000000003");
});

test("propose: long calldata keeps agentReason within Sato OS's 2000 chars; full intent still carried", () => {
  const big = intent({ unsigned: { kind: "evm_tx", chain: "base", chain_id: 8453, from: null, to: "0x0000000000000000000000000000000000000001", data: "0x" + "ab".repeat(4000), value: "0" } });
  const a = proposalArguments(big);
  assert.ok((a.agentReason as string).length <= 2000);
  assert.deepEqual(a.satoKitIntent, big);
});

test("a refused intent is never proposed (no request leaves)", async () => {
  const n = seen.length;
  const refused = intent({ policy: { ok: false, refusals: [{ rule: "max_usd_per_tx" as any, limit: "10", observed: "50", message: "over cap" }] } });
  await assert.rejects(proposeIntent(refused, { baseUrl: base, token: TOKEN, clock: () => NOW }), (e: unknown) => e instanceof SatoOsError && e.code === "refused_intent");
  await assert.rejects(proposeIntent(intent(), { baseUrl: base, token: TOKEN, clock: () => Date.parse("2026-09-28T13:00:00Z") }), (e: unknown) => e instanceof SatoOsError && e.code === "expired_intent");
  assert.equal(seen.length, n);
});

test("a bad token is a hard error, not a fallback", async () => {
  await assert.rejects(proposeIntent(intent(), { baseUrl: base, token: "nope", clock: () => NOW }), (e: unknown) => e instanceof SatoOsError && e.status === 401);
});

test("the hand-off path never signs: no signer, key or broadcast anywhere in the module", async () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const src = await readFile(join(ROOT, "src/sato-os/index.ts"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  for (const bad of [/signers/, /sendTransaction/, /signTypedData/, /privateKey/i, /viem/, /eth_sendRawTransaction/]) assert.doesNotMatch(code, bad);
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./sato-os"], { types: "./dist/sato-os/index.d.ts", default: "./dist/sato-os/index.js" });
  // Exported only via the subpath, not the root barrel.
  assert.doesNotMatch(await readFile(join(ROOT, "src/index.ts"), "utf8"), /sato-os/);
});
