// One pass of a Base agent: read the market, decide what it would like to do,
// check that against its policy, ask for a swap QUOTE, and report.
//
// It never signs and never broadcasts. It does not send a `taker`, so Sato Hub
// builds no transaction at all: the response carries a price and a venue, and
// `tx`/`calldata` come back null. If one ever came back non-null, this code
// would refuse to look at it.

import { SatoHubClient } from "satohub-core";
import { formatUnits, parseUnits } from "viem";
import { readMarket } from "./market.js";
import { BASE_CHAIN_ID, DEFAULT_POLICY, PolicyWallet, TOKENS, type Intent } from "./policy.js";

const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const AMOUNT_USDC = Number(process.env.AMOUNT_USDC || "10");
const USER_AGENT = process.env.SATO_USER_AGENT || "base-ts-agent-starter/0.1";

type RouteSwap = {
  route_id: string;
  route: { slug: string; name: string; sato_url: string | null };
  quote: { venue: string; amount_in: string; amount_out: string; tx: unknown; calldata: unknown; source_url?: string };
  sato_fee_bps: number;
  disclosure: string;
  preflight?: { verdict: string; rule?: string } | null;
  caveat: string;
  checked_at: string;
};

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(18)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function main() {
  const wallet = new PolicyWallet(DEFAULT_POLICY);
  console.log("Policy");
  line("chain", wallet.policy.chainId);
  line("actions", wallet.policy.actions.join(", "));
  line("tokens", "USDC, WETH (Base)");
  line("max quote size", `${wallet.policy.maxAmountInUsd} USD`);
  line("key held", "none — this wallet cannot sign");

  // 1. Read.
  const readOk = wallet.authorize({ action: "read", chainId: BASE_CHAIN_ID });
  if (!readOk.allowed) throw new Error(`policy refused read: ${readOk.rule}`);
  const market = await readMarket(RPC);
  console.log("\nMarket (read-only, Base)");
  line("block", market.block);
  line("gas price", `${market.gas_price_gwei} gwei`);
  line("ETH/USD", `${market.eth_usd.toFixed(2)} — ${market.eth_usd_feed}`);
  line("feed updated", `${market.eth_usd_updated_at} (${market.eth_usd_age_s}s ago)`);
  line("rpc", market.rpc);

  // 2. Decide, then ask the policy. Two intents the policy must refuse are
  // shown first, so the refusal path is exercised on every run.
  console.log("\nPolicy checks");
  const demos: [string, Intent][] = [
    ["sign a transaction", { action: "sign", chainId: BASE_CHAIN_ID }],
    ["quote 1000 USDC", { action: "quote", chainId: BASE_CHAIN_ID, tokenIn: TOKENS.USDC, tokenOut: TOKENS.WETH, amountInUsd: 1000 }],
  ];
  for (const [label, intent] of demos) {
    const d = wallet.authorize(intent);
    line(label, d.allowed ? "allowed" : `refused ${d.rule} (limit ${d.limit}, saw ${d.observed})`);
  }
  const intent: Intent = { action: "quote", chainId: BASE_CHAIN_ID, tokenIn: TOKENS.USDC, tokenOut: TOKENS.WETH, amountInUsd: AMOUNT_USDC };
  const decision = wallet.authorize(intent);
  line(`quote ${AMOUNT_USDC} USDC`, decision.allowed ? "allowed" : `refused ${decision.rule} (limit ${decision.limit}, saw ${decision.observed})`);
  if (!decision.allowed) {
    console.log("\nThe policy refused the agent's own intent; nothing further was asked. Done.");
    return;
  }

  // 3. Quote. No taker → no transaction is built.
  const sato = new SatoHubClient({ userAgent: USER_AGENT });
  const amountIn = parseUnits(String(AMOUNT_USDC), 6).toString();
  const { data, signature } = await sato.routeSwap({ chain: "base", token_in: TOKENS.USDC, token_out: TOKENS.WETH, amount: amountIn });
  const r = data as RouteSwap;
  if (r.quote?.tx != null || r.quote?.calldata != null) {
    throw new Error("A transaction came back although no taker was sent. This starter does not handle transactions; stopping.");
  }
  const outWeth = Number(formatUnits(BigInt(r.quote.amount_out), 18));
  const impliedEthUsd = AMOUNT_USDC / outWeth;
  const vsFeedPct = ((impliedEthUsd - market.eth_usd) / market.eth_usd) * 100;

  console.log("\nSwap quote (unsigned — no transaction was built)");
  line("venue", `${r.route.name}${r.route.sato_url ? ` — ${r.route.sato_url}` : ""}`);
  line("venue preflight", r.preflight ? `${r.preflight.verdict}${r.preflight.rule ? ` (rule ${r.preflight.rule})` : ""} — what is on record, not a review` : "none returned");
  line("in", `${AMOUNT_USDC} USDC`);
  line("out (quoted)", `${outWeth.toFixed(8)} WETH`);
  // The quoted output already has the Sato Route fee taken out (see the
  // disclosure below), so the implied price includes it. The feed also lags
  // the market by up to its heartbeat; the comparison is a sanity check only.
  line("implied ETH/USD", `${impliedEthUsd.toFixed(2)} (${vsFeedPct >= 0 ? "+" : ""}${vsFeedPct.toFixed(2)}% vs the Chainlink feed, fee included)`);
  line("route id", r.route_id);
  line("signature", signature.state === "verified" ? `verified (kid ${signature.kid}, signed ${signature.signed_at})` : `${signature.state}: ${"reason" in signature ? signature.reason : ""}`);
  line("checked at", r.checked_at);
  console.log(`\n  Fee disclosure, verbatim:\n  ${r.disclosure}`);
  console.log(`\n  ${r.caveat}`);

  console.log("\nDone. Nothing was signed, sent or spent.");
}

main().catch((e) => {
  console.error(`\nStopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
