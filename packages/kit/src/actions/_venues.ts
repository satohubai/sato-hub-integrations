// ACTIONS builder. The swap venue clients. Venue-neutral by construction:
// each client returns the same SwapQuote shape, nothing here orders, scores or
// compares venues, and a non-Sato venue is never penalised. Sato Swap is the
// labelled default and its fee sentence is passed through verbatim; LI.FI and
// 0x carry no Sato fee and their own fee fields are passed through as the
// upstream returned them.
import type { ActionContext } from "../types.js";
import { EVM_CHAIN_IDS, errorMessage, http } from "./_util.js";
import type { EvmChain } from "./_util.js";

export const SATO_SWAP_URL = "https://satohub.ai/api/swap/quote";
export const LIFI_QUOTE_URL = "https://li.quest/v1/quote";
export const ZEROX_BASE_URL = "https://api.0x.org/swap/allowance-holder";

/** Venues a caller can name. "direct" = the no-Sato-fee quote (LI.FI) only. */
export const SWAP_VENUES = ["sato", "direct", "lifi", "0x"] as const;
export type SwapVenue = (typeof SWAP_VENUES)[number];

/** The address LI.FI is asked to quote for when the caller gave no taker. It only shapes the quote. */
export const QUOTE_ONLY_FROM = "0x000000000000000000000000000000000000dEaD";

export type SwapRequest = {
  chain: EvmChain;
  sell_token: string;
  buy_token: string;
  sell_amount: string;
  taker: string | null;
  slippage_bps: number;
};

export type VenueTx = { to: string; data: string; value: string; gas: string | null; chain_id: number; approval_target: string | null };

export type SwapQuote = {
  venue: "sato" | "lifi" | "0x";
  chain: EvmChain;
  sell_token: string;
  buy_token: string;
  sell_amount: string;
  buy_amount: string | null;
  buy_amount_min: string | null;
  /** The upstream aggregator or tool that produced the route, as the venue names it. */
  route_via: string | null;
  /** Sato's fee in bps: the Sato response's own figure for venue sato; 0 for every other venue. */
  sato_fee_bps: number | null;
  sato_fee_recipient: string | null;
  /** Sato's fee sentence, verbatim, for venue sato; a plain statement for the others. */
  fee_disclosure: string;
  /** The venue's own fee fields, exactly as returned; null for sato (its sentence covers it). */
  upstream_fees: unknown;
  /** USD value of the sell side when the venue returned one; null otherwise (never estimated here). */
  sell_usd: number | null;
  /** Present only on executable (prepare) quotes. */
  tx: VenueTx | null;
  /** Why a tx is absent or the quote failed; null when fine. */
  error: string | null;
  as_of: string;
};

export const NO_SATO_FEE_STATEMENT =
  "No Sato fee is added to this quote. The venue's own fees are in upstream_fees exactly as the venue returned them.";

function blank(venue: SwapQuote["venue"], r: SwapRequest, as_of: string, error: string): SwapQuote {
  return {
    venue, chain: r.chain, sell_token: r.sell_token, buy_token: r.buy_token, sell_amount: r.sell_amount,
    buy_amount: null, buy_amount_min: null, route_via: null,
    sato_fee_bps: venue === "sato" ? null : 0, sato_fee_recipient: null,
    fee_disclosure: venue === "sato" ? "unknown: the Sato Swap response could not be read, so no fee sentence is available" : NO_SATO_FEE_STATEMENT,
    upstream_fees: null, sell_usd: null, tx: null, error, as_of,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
function hexToDec(v: unknown): string {
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v).toString();
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return v;
  return "0";
}

/** Sato Swap, POST /api/swap/quote. mode "recommend" quotes; "build-tx" needs a taker and returns an unsigned tx. */
export async function satoQuote(ctx: ActionContext, r: SwapRequest, mode: "recommend" | "build-tx", as_of: string): Promise<SwapQuote> {
  const body: Record<string, unknown> = {
    chain_in: r.chain, token_in: r.sell_token, token_out: r.buy_token, amount_in: r.sell_amount, slippage_bps: r.slippage_bps, mode,
  };
  if (r.taker) body.taker = r.taker;
  let res;
  try {
    res = await http(ctx, SATO_SWAP_URL, { method: "POST", body });
  } catch (e) {
    return blank("sato", r, as_of, `request_failed: ${errorMessage(e)}`);
  }
  const b = (res.body ?? {}) as Record<string, unknown>;
  if (res.status !== 200) return blank("sato", r, as_of, `http_${res.status}: ${str(b.error) ?? "no body"}`);
  if ("unavailable" in b) return blank("sato", r, as_of, `no_route: ${str(b.caveat) ?? "Sato Swap found no route for this pair"}`);
  if (typeof b.disclosure !== "string") return blank("sato", r, as_of, "malformed: the response carried no fee disclosure");
  const t = b.tx as Record<string, unknown> | null | undefined;
  const withheld = b.withheld as { reason?: unknown; rule?: unknown } | null | undefined;
  let tx: VenueTx | null = null;
  if (t && typeof t.to === "string" && typeof t.data === "string") {
    tx = {
      to: t.to, data: t.data, value: hexToDec(t.value), gas: str(t.gas),
      chain_id: typeof t.chain_id === "number" ? t.chain_id : EVM_CHAIN_IDS[r.chain],
      approval_target: typeof t.approval_target === "string" ? t.approval_target : t.to,
    };
  }
  return {
    venue: "sato", chain: r.chain, sell_token: r.sell_token, buy_token: r.buy_token, sell_amount: r.sell_amount,
    buy_amount: str(b.amount_out), buy_amount_min: null, route_via: str(b.venue),
    sato_fee_bps: typeof b.sato_fee_bps === "number" ? b.sato_fee_bps : null,
    sato_fee_recipient: str(b.sato_fee_recipient),
    fee_disclosure: b.disclosure,
    upstream_fees: null, sell_usd: null, tx,
    error: mode === "build-tx" && !tx ? `withheld: ${str(withheld?.rule) ?? "?"} ${str(withheld?.reason) ?? "no transaction returned"}` : null,
    as_of,
  };
}

/** LI.FI GET /v1/quote. Keyless. Returns a transactionRequest, so one call serves quote and prepare. */
export async function lifiQuote(ctx: ActionContext, r: SwapRequest, as_of: string): Promise<SwapQuote> {
  const id = String(EVM_CHAIN_IDS[r.chain]);
  const q = new URLSearchParams({
    fromChain: id, toChain: id, fromToken: r.sell_token, toToken: r.buy_token, fromAmount: r.sell_amount,
    fromAddress: r.taker ?? QUOTE_ONLY_FROM, slippage: String(r.slippage_bps / 10_000),
  });
  let res;
  try {
    res = await http(ctx, `${LIFI_QUOTE_URL}?${q.toString()}`);
  } catch (e) {
    return blank("lifi", r, as_of, `request_failed: ${errorMessage(e)}`);
  }
  const b = (res.body ?? {}) as Record<string, unknown>;
  if (res.status !== 200) return blank("lifi", r, as_of, `http_${res.status}: ${str(b.message) ?? "no body"}`);
  const est = (b.estimate ?? {}) as Record<string, unknown>;
  const tr = b.transactionRequest as Record<string, unknown> | undefined;
  const tx: VenueTx | null = r.taker && tr && typeof tr.to === "string" && typeof tr.data === "string"
    ? {
        to: tr.to, data: tr.data, value: hexToDec(tr.value), gas: tr.gasLimit ? hexToDec(tr.gasLimit) : null,
        chain_id: typeof tr.chainId === "number" ? tr.chainId : EVM_CHAIN_IDS[r.chain],
        approval_target: str(est.approvalAddress) ?? tr.to,
      }
    : null;
  return {
    venue: "lifi", chain: r.chain, sell_token: r.sell_token, buy_token: r.buy_token, sell_amount: r.sell_amount,
    buy_amount: str(est.toAmount), buy_amount_min: str(est.toAmountMin), route_via: str(b.tool),
    sato_fee_bps: 0, sato_fee_recipient: null, fee_disclosure: NO_SATO_FEE_STATEMENT,
    upstream_fees: { feeCosts: est.feeCosts ?? null, gasCosts: est.gasCosts ?? null },
    sell_usd: num(est.fromAmountUSD), tx,
    error: null,
    as_of,
  };
}

/** 0x Swap API v2 (allowance-holder). Needs an API key; "price" is indicative, "quote" is executable and needs a taker. */
export async function zeroexQuote(ctx: ActionContext, r: SwapRequest, apiKey: string, kind: "price" | "quote", as_of: string): Promise<SwapQuote> {
  const q = new URLSearchParams({
    chainId: String(EVM_CHAIN_IDS[r.chain]), sellToken: r.sell_token, buyToken: r.buy_token, sellAmount: r.sell_amount,
    slippageBps: String(r.slippage_bps),
  });
  if (r.taker) q.set("taker", r.taker);
  let res;
  try {
    res = await http(ctx, `${ZEROX_BASE_URL}/${kind}?${q.toString()}`, { headers: { "0x-api-key": apiKey, "0x-version": "v2" } });
  } catch (e) {
    return blank("0x", r, as_of, `request_failed: ${errorMessage(e)}`);
  }
  const b = (res.body ?? {}) as Record<string, unknown>;
  if (res.status !== 200) return blank("0x", r, as_of, `http_${res.status}: ${str(b.message) ?? str(b.name) ?? "no body"}`);
  if (b.liquidityAvailable === false) return blank("0x", r, as_of, "no_route: 0x reported no liquidity for this pair");
  const t = b.transaction as Record<string, unknown> | undefined;
  const issues = b.issues as { allowance?: { spender?: unknown } | null } | undefined;
  const tx: VenueTx | null = kind === "quote" && t && typeof t.to === "string" && typeof t.data === "string"
    ? {
        to: t.to, data: t.data, value: hexToDec(t.value), gas: t.gas ? hexToDec(t.gas) : null, chain_id: EVM_CHAIN_IDS[r.chain],
        approval_target: str(issues?.allowance?.spender) ?? str(b.allowanceTarget) ?? t.to,
      }
    : null;
  const route = b.route as { fills?: Array<{ source?: unknown }> } | undefined;
  return {
    venue: "0x", chain: r.chain, sell_token: r.sell_token, buy_token: r.buy_token, sell_amount: r.sell_amount,
    buy_amount: str(b.buyAmount), buy_amount_min: str(b.minBuyAmount),
    route_via: route?.fills?.map((f) => str(f.source)).filter(Boolean).join("+") || null,
    sato_fee_bps: 0, sato_fee_recipient: null, fee_disclosure: NO_SATO_FEE_STATEMENT,
    upstream_fees: b.fees ?? null, sell_usd: null, tx, error: null, as_of,
  };
}
