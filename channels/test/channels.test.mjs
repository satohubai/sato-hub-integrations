// Offline, deterministic checks on the channel drafts. No network: every fetch
// and RPC client here is a local fake fed with recorded fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePolicyFile } from "@satohub/kit";
import { toClawhub, SOURCE, TARGET } from "../skills/build-clawhub-skill.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..");
const build = join(root, ".test-build");
const kitPkg = JSON.parse(readFileSync(join(repo, "packages", "kit", "package.json"), "utf8"));
const fixture = (name) => JSON.parse(readFileSync(join(repo, "packages", "kit", "test", "fixtures", name), "utf8"));

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const clock = () => NOW;

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".test-build") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

// ── voice ────────────────────────────────────────────────────────────────────

test("no banned wording anywhere in channels/", () => {
  const banned = /\b(safe|safely|safety|secure|security|best|fee-free|guarantee[ds]?|risk-free|audited|trusted)\b/i;
  const hits = [];
  for (const f of files(root)) {
    if (f === fileURLToPath(import.meta.url)) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (banned.test(line)) hits.push(`${relative(root, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("no floating @latest for our own package", () => {
  const hits = files(root).filter((f) => /@satohub\/kit@latest/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits.map((f) => relative(root, f)), []);
});

// ── policies ─────────────────────────────────────────────────────────────────

test("every policy.json is a valid sato.policy/v1, refuses unknowns and is not mainnet", () => {
  const policies = files(root).filter((f) => f.endsWith("policy.json"));
  assert.ok(policies.length >= 3);
  for (const f of policies) {
    const parsed = parsePolicyFile(JSON.parse(readFileSync(f, "utf8")));
    assert.ok(parsed.ok, `${relative(root, f)}: ${parsed.error}`);
    assert.equal(parsed.policy.unknown_verdict, "refuse", relative(root, f));
    assert.notEqual(parsed.policy.network, "mainnet", relative(root, f));
  }
});

// ── Base MCP plugin spec ─────────────────────────────────────────────────────

function frontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(m, "frontmatter");
  return m[1];
}

test("Base MCP plugin: required frontmatter, cli-only flags, pinned kit version", () => {
  const md = readFileSync(join(root, "base-mcp", "sato-kit.md"), "utf8");
  const fm = frontmatter(md);
  for (const k of ["title", "description", "tags", "name", "version", "integration", "chains"]) {
    assert.match(fm, new RegExp(`^${k}:`, "m"), `missing ${k}`);
  }
  assert.match(fm, /^integration: cli-only$/m);
  assert.match(fm, /^  shell: required$/m);
  assert.match(fm, /^  externalMcp: null$/m);
  assert.match(fm, /^auth: none$/m);
  const risk = /^risk: \[(.*)\]$/m.exec(fm)?.[1].split(",").map((s) => s.trim());
  assert.ok(risk?.includes("local-exec"), "cliPackage needs the local-exec risk tag");
  const cli = /^  cliPackage: "(.+)"$/m.exec(fm)?.[1];
  assert.equal(cli, `npx -y @satohub/kit@${kitPkg.version}`);
  const chains = /^chains: \[(.*)\]$/m.exec(fm)?.[1].split(",").map((s) => s.trim());
  const supported = ["arbitrum", "avalanche", "base", "base-sepolia", "bsc", "ethereum", "optimism", "polygon"];
  for (const c of chains ?? []) assert.ok(supported.includes(c), c);
  // every CLI invocation in the body uses the same pin
  for (const m of md.matchAll(/@satohub\/kit@([0-9A-Za-z.\-]+)/g)) assert.equal(m[1], kitPkg.version);
});

test("Base MCP plugin: canonical sections in canonical order", () => {
  const md = readFileSync(join(root, "base-mcp", "sato-kit.md"), "utf8");
  const body = md.slice(md.indexOf("\n---\n", 4) + 5);
  const firstNonHeading = body.split("\n").find((l) => l.trim() && !l.startsWith("# "));
  assert.equal(firstNonHeading, "> [!IMPORTANT]");
  const h2 = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(h2, [
    "Overview",
    "Installation",
    "Surface Routing",
    "Commands",
    "Orchestration",
    "Submission",
    "Example Prompts",
    "Risks & Warnings",
    "Notes",
  ]);
  assert.match(body, /Target tool: \*\*`send_calls`\*\*/);
});

// ── skills ───────────────────────────────────────────────────────────────────

test("ClawHub SKILL.md is the kit skill with ClawHub's two frontmatter changes, and is current", () => {
  const src = readFileSync(SOURCE, "utf8");
  const have = readFileSync(TARGET, "utf8");
  assert.equal(have, toClawhub(src), "run node channels/skills/build-clawhub-skill.mjs");
  const fm = frontmatter(have);
  assert.doesNotMatch(fm, /^license:/m);
  assert.match(fm, new RegExp(`^version: ${kitPkg.version.replace(/\./g, "\\.")}$`, "m"));
  assert.match(fm, /^name: sato-kit$/m);
  assert.equal(have.slice(have.indexOf("\n---\n", 4)), src.slice(src.indexOf("\n---\n", 4)), "body must be byte-identical");
});

// ── Scaffold-ETH extension ───────────────────────────────────────────────────

const ext = join(root, "scaffold-eth-extension", "extension");

test("Scaffold-ETH extension: create-eth layout", () => {
  for (const p of [
    "README.md.args.mjs",
    "AGENTS.md.args.mjs",
    "packages/nextjs/package.json",
    "packages/nextjs/policy.json",
    "packages/nextjs/app/sato-swap/page.tsx",
    "packages/nextjs/app/api/sato/prepare/route.ts",
    "packages/nextjs/hooks/sato/useGuardedSwap.ts",
    "packages/nextjs/components/Header.tsx.args.mjs",
  ]) {
    assert.ok(statSync(join(ext, p)).isFile(), p);
  }
  const pkg = JSON.parse(readFileSync(join(ext, "packages/nextjs/package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg), ["dependencies"], "an extension package.json adds dependencies only");
  assert.equal(pkg.dependencies["@satohub/kit"], kitPkg.version);
  // browser code never imports the kit's runtime (only types)
  for (const p of ["packages/nextjs/hooks/sato/useGuardedSwap.ts", "packages/nextjs/utils/sato/walletTx.ts", "packages/nextjs/app/sato-swap/page.tsx"]) {
    const src = readFileSync(join(ext, p), "utf8");
    assert.doesNotMatch(src, /^import \{[^}]*\} from "@satohub\/kit/m, `${p} imports kit runtime`);
    assert.doesNotMatch(src, /utils\/sato\/guardedSwap"/, `${p} imports the server module`);
  }
});

function preparedIntent(over = {}) {
  return {
    intent_id: "si_" + "A".repeat(43),
    action: "swap.prepare",
    expires_at: new Date(NOW + 60_000).toISOString(),
    summary: "Swap 10 USDC for WETH on base via lifi.",
    policy: { ok: true, refusals: [] },
    simulation: { ok: true, method: "eth_call", block: "1", gas_estimate: "21000", error: null, as_of: new Date(NOW).toISOString() },
    fee_disclosure: null,
    unsigned: { kind: "evm_tx", chain: "base", chain_id: 8453, from: null, to: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", data: "0xabcdef", value: "0" },
    ...over,
  };
}

test("walletTxFor: only a passed, simulated, unexpired EVM intent becomes a wallet request", async () => {
  const { walletTxFor } = await import(join(build, "scaffold-eth-extension/extension/packages/nextjs/utils/sato/walletTx.js"));
  const ok = walletTxFor(preparedIntent(), NOW);
  assert.deepEqual(ok, { tx: { to: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", data: "0xabcdef", value: 0n, chainId: 8453 } });
  assert.ok("blocked" in walletTxFor(preparedIntent({ policy: { ok: false, refusals: [{ rule: "max_usd_per_trade", limit: "25", observed: "500", message: "" }] } }), NOW));
  assert.ok("blocked" in walletTxFor(preparedIntent({ simulation: null }), NOW));
  assert.ok("blocked" in walletTxFor(preparedIntent({ simulation: { ...preparedIntent().simulation, ok: false, error: "revert" } }), NOW));
  assert.ok("blocked" in walletTxFor(preparedIntent({ expires_at: new Date(NOW - 1).toISOString() }), NOW));
  assert.ok("blocked" in walletTxFor(preparedIntent({ unsigned: { kind: "x402_payment", network: "base", resource: "x", pay_to: "0x", asset: "0x", amount: "1" } }), NOW));
});

function fakeClient(impl) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      return async (...a) => {
        const f = impl[prop];
        if (typeof f !== "function") throw new Error(`fake client: ${String(prop)} not stubbed`);
        return f(...a);
      };
    },
  });
}

const lifiFetch = async () => new Response(JSON.stringify(fixture("lifi-quote.base.json")), { status: 200, headers: { "content-type": "application/json" } });
const SWAP = {
  chain: "base",
  sell_token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  buy_token: "0x4200000000000000000000000000000000000006",
  sell_amount: "10000000",
  taker: "0x000000000000000000000000000000000000dEaD",
  venue: "lifi",
};

test("prepareGuardedSwap (fixtures): a passing swap is sendable; a failed simulation is not", async () => {
  const { buildGuardedSwapKit, prepareGuardedSwap, walletTxFor } = await import(join(build, "scaffold-eth-extension/extension/packages/nextjs/utils/sato/guardedSwap.js"));
  const policy = JSON.parse(readFileSync(join(ext, "packages/nextjs/policy.json"), "utf8"));
  const good = fakeClient({ readContract: async () => 10n ** 30n, getBlockNumber: async () => 1n, call: async () => ({ data: "0x" }), estimateGas: async () => 200000n });
  const kitOk = buildGuardedSwapKit({ policy, fetch: lifiFetch, clock, makeClient: () => good });
  const r = await prepareGuardedSwap(kitOk, SWAP);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.intent.policy.ok, true, JSON.stringify(r.intent.policy));
  assert.ok("tx" in walletTxFor(r.intent, NOW));

  const reverting = fakeClient({ readContract: async () => 10n ** 30n, getBlockNumber: async () => 1n, call: async () => { throw new Error("execution reverted"); }, estimateGas: async () => 200000n });
  const kitBad = buildGuardedSwapKit({ policy, fetch: lifiFetch, clock, makeClient: () => reverting });
  const r2 = await prepareGuardedSwap(kitBad, SWAP);
  assert.equal(r2.ok, true);
  assert.equal(r2.intent.policy.ok, false);
  assert.ok(r2.intent.policy.refusals.some((x) => x.rule.startsWith("simulation")), JSON.stringify(r2.intent.policy.refusals));
  assert.ok("blocked" in walletTxFor(r2.intent, NOW));
});

test("prepareGuardedSwap (fixtures): the per-trade cap refuses and names the rule", async () => {
  const { buildGuardedSwapKit, prepareGuardedSwap } = await import(join(build, "scaffold-eth-extension/extension/packages/nextjs/utils/sato/guardedSwap.js"));
  const policy = { ...JSON.parse(readFileSync(join(ext, "packages/nextjs/policy.json"), "utf8")), max_usd_per_trade: 5 };
  const good = fakeClient({ readContract: async () => 10n ** 30n, getBlockNumber: async () => 1n, call: async () => ({ data: "0x" }), estimateGas: async () => 200000n });
  const r = await prepareGuardedSwap(buildGuardedSwapKit({ policy, fetch: lifiFetch, clock, makeClient: () => good }), SWAP);
  assert.equal(r.ok, true);
  const cap = r.intent.policy.refusals.find((x) => x.rule === "max_usd_per_trade");
  assert.ok(cap, JSON.stringify(r.intent.policy.refusals));
  assert.equal(cap.limit, "5");
});

// ── Cloudflare Agents x402 ───────────────────────────────────────────────────

const X402 = fixture("x402-v2-payment-required.json");
const x402Fetch = async () => new Response(JSON.stringify({}), { status: 402, headers: { "payment-required": X402.header, "content-type": "application/json" } });
const cfPolicy = () => JSON.parse(readFileSync(join(root, "cloudflare-agents-x402", "src", "policy.json"), "utf8"));
const URL402 = "https://api.example.com/premium-data";

test("x402 pre-flight: inside the budget it approves exactly one requirement", async () => {
  const { buildX402Kit, preflightPayment, onlyApprovedRequirement } = await import(join(build, "cloudflare-agents-x402/src/guard.js"));
  const pre = await preflightPayment(buildX402Kit({ policy: cfPolicy(), fetch: x402Fetch, clock }), { url: URL402, maxAmountBaseUnits: "100000" });
  assert.equal(pre.ok, true, JSON.stringify(pre));
  const req = X402.decoded.accepts[0];
  assert.equal(pre.approved.pay_to.toLowerCase(), req.payTo.toLowerCase());
  assert.equal(pre.approved.amount, req.amount);

  const keep = onlyApprovedRequirement(pre.approved);
  assert.deepEqual(keep(2, [req]), [req]);
  assert.deepEqual(keep(2, [{ ...req, payTo: "0x0000000000000000000000000000000000000001" }]), []);
  assert.deepEqual(keep(2, [{ ...req, amount: "10001" }]), []);
  assert.deepEqual(keep(2, [{ ...req, network: "eip155:8453" }]), []);
  assert.deepEqual(keep(2, [{ ...req, asset: "0x0000000000000000000000000000000000000002" }]), []);
});

test("x402 pre-flight: over the budget or over the USD cap, nothing is approved and the rules are named", async () => {
  const { buildX402Kit, preflightPayment } = await import(join(build, "cloudflare-agents-x402/src/guard.js"));
  const low = await preflightPayment(buildX402Kit({ policy: cfPolicy(), fetch: x402Fetch, clock }), { url: URL402, maxAmountBaseUnits: "5000" });
  assert.equal(low.ok, false);

  const capped = await preflightPayment(buildX402Kit({ policy: { ...cfPolicy(), max_usd_per_trade: 0.005 }, fetch: x402Fetch, clock }), { url: URL402, maxAmountBaseUnits: "100000" });
  assert.equal(capped.ok, false);
  assert.ok(capped.refusals.some((r) => r.rule === "max_usd_per_trade"), JSON.stringify(capped));
});

// ── AgentKit example ─────────────────────────────────────────────────────────

test("AgentKit example: walletProviderSigner refuses a chain mismatch and passes the exact tx", async () => {
  const { walletProviderSigner } = await import(join(build, "agentkit-example/typescript/examples/langchain-sato-kit-chatbot/sato.js"));
  const sent = [];
  const wp = {
    getAddress: () => "0x000000000000000000000000000000000000dEaD",
    getNetwork: () => ({ protocolFamily: "evm", networkId: "base-sepolia", chainId: "84532" }),
    sendTransaction: async (tx) => { sent.push(tx); return "0x" + "ab".repeat(32); },
    signTypedData: async () => "0x",
  };
  const s = walletProviderSigner(wp);
  const tx = { kind: "evm_tx", chain: "base", chain_id: 8453, from: null, to: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", data: "0xabcdef", value: "7" };
  await assert.rejects(() => s.sendTransaction(tx), /chain id 8453/);
  assert.equal(sent.length, 0);
  const out = await s.sendTransaction({ ...tx, chain: "base-sepolia", chain_id: 84532 });
  assert.equal(out.tx_hash, "0x" + "ab".repeat(32));
  assert.deepEqual(sent, [{ to: tx.to, data: tx.data, value: 7n }]);
});

test("AgentKit example: layout mirrors typescript/examples/langchain-cdp-chatbot", () => {
  const dir = join(root, "agentkit-example", "typescript", "examples", "langchain-sato-kit-chatbot");
  for (const f of [".env-local", ".eslintrc.json", ".prettierignore", ".prettierrc", "README.md", "chatbot.ts", "package.json", "tsconfig.json", "policy.json", "sato.ts"]) {
    assert.ok(statSync(join(dir, f)).isFile(), f);
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@coinbase/agentkit"], "workspace:*");
  assert.equal(pkg.dependencies["@satohub/kit"], kitPkg.version);
  assert.match(readFileSync(join(dir, "README.md"), "utf8"), /## What it does NOT do/);
});
