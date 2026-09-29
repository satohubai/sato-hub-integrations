// ACTIONS builder. The bridge input and venue clients shared by bridge.quote
// and bridge.prepare. Venue-neutral by construction (scope §0.3), exactly as
// the swap venues are: each client returns the same BridgeQuote shape, nothing
// here orders, scores or compares venues, and a non-Sato venue is never
// penalised. Sato Route's cross-chain lane is the labelled default and its fee
// sentence and fee figure are passed through verbatim from the response (the
// rate is never typed here); LI.FI carries no Sato fee and its own fee fields
// are passed through as LI.FI returned them.
//
// A bridge is the cross-chain lane only. Same-chain input is refused (that is
// swap.quote), and a Sato answer that says it is not cross-chain is reported
// as an error rather than shown beside a cross-chain quote: the two lanes are
// never put side by side.
import type { ActionContext } from "../types.js";
import { TOKEN_PATTERN } from "./_swap_input.js";
import {
  ActionInputError, EVM_CHAIN_IDS, SWAP_CHAINS, address, baseUnits, chainSchema, errorMessage, evmChain, http, obj, optAddress, slippage,
} from "./_util.js";
import type { EvmChain } from "./_util.js";
import { LIFI_QUOTE_URL, NO_SATO_FEE_STATEMENT, QUOTE_ONLY_FROM, SATO_SWAP_URL } from "./_venues.js";
import type { VenueTx } from "./_venues.js";

/** Venues a caller can name. "direct" = the no-Sato-fee quote (LI.FI) only. */
export const BRIDGE_VENUES = ["sato", "direct", "lifi"] as const;
export type BridgeVenue = (typeof BRIDGE_VENUES)[number];

const TOKEN_RE = new RegExp(TOKEN_PATTERN);

export type BridgeRequest = {
  from_chain: EvmChain;
  to_chain: EvmChain;
  from_token: string;
  to_token: string;
  from_amount: string;
  /** The address that would sign on the source chain; null on a quote without one. */
  from_address: string | null;
  /** Where the output lands on the destination chain; null = from_address. */
  to_address: string | null;
  slippage_bps: number;
};

export type BridgeQuote = {
  venue: "sato" | "lifi";
  lane: "cross-chain";
  from_chain: EvmChain;
  to_chain: EvmChain;
  from_token: string;
  to_token: string;
  from_amount: string;
  to_amount: string | null;
  to_amount_min: string | null;
  /** The bridge or tool the venue routed through, as the venue names it. */
  route_via: string | null;
  /** Seconds the venue estimates the transfer takes, when it states one. */
  est_duration_s: number | null;
  /** Sato's fee in bps: the Sato response's own figure for venue sato; 0 for LI.FI. */
  sato_fee_bps: number | null;
  sato_fee_recipient: string | null;
  /** Sato's fee sentence, verbatim, for venue sato; a plain statement for LI.FI. */
  fee_disclosure: string;
  /** The venue's own fee fields, exactly as returned; null for sato (its sentence covers it). */
  upstream_fees: unknown;
  /** USD value of the source side when the venue returned one; null otherwise (never estimated here). */
  from_usd: number | null;
  /** Source-chain transaction; present only on executable (prepare) quotes. */
  tx: VenueTx | null;
  error: string | null;
  as_of: string;
};

export type ParsedBridgeInput = { request: BridgeRequest; venue: BridgeVenue };

export function bridgeInputProperties() {
  return {
    from_chain: chainSchema(SWAP_CHAINS, "Source chain: the transaction is signed here."),
    to_chain: chainSchema(SWAP_CHAINS, "Destination chain. Must differ from from_chain; a same-chain trade is swap.quote."),
    from_token: { type: "string", pattern: TOKEN_PATTERN, description: "Token sent on the source chain: a 0x address or a symbol." },
    to_token: { type: "string", pattern: TOKEN_PATTERN, description: "Token received on the destination chain: a 0x address or a symbol." },
    from_amount: { type: "string", pattern: "^[0-9]{1,78}$", description: "Amount sent, in base units of from_token, as a decimal string." },
    from_address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Address that would sign on the source chain." },
    to_address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Receiving address on the destination chain. Defaults to from_address." },
    slippage_bps: { type: "integer", minimum: 0, maximum: 5000, description: "Slippage tolerance in basis points. Defaults to 50." },
    venue: {
      type: "string",
      enum: [...BRIDGE_VENUES],
      description: "sato (the labelled default, returned together with a quote carrying no Sato fee), direct or lifi (LI.FI only; Sato is not called).",
    },
  };
}

export function parseBridgeInput(input: unknown, action: string, requireFrom: boolean): ParsedBridgeInput {
  const o = obj(input, action);
  const from_chain = evmChain(o.from_chain, SWAP_CHAINS, action);
  const to_chain = evmChain(o.to_chain, SWAP_CHAINS, action);
  if (from_chain === to_chain) {
    throw new ActionInputError(`${action}: from_chain and to_chain are the same; a same-chain trade is swap.quote / swap.prepare`);
  }
  for (const f of ["from_token", "to_token"] as const) {
    if (typeof o[f] !== "string" || !TOKEN_RE.test(o[f] as string)) throw new ActionInputError(`${action}: ${f} must be a 0x address or a token symbol`);
  }
  const venue = (o.venue ?? "sato") as BridgeVenue;
  if (!BRIDGE_VENUES.includes(venue)) throw new ActionInputError(`${action}: venue must be one of ${BRIDGE_VENUES.join(", ")}`);
  const from_address = requireFrom ? address(o.from_address, "from_address", action) : optAddress(o.from_address, "from_address", action);
  return {
    request: {
      from_chain, to_chain,
      from_token: o.from_token as string,
      to_token: o.to_token as string,
      from_amount: baseUnits(o.from_amount, "from_amount", action),
      from_address,
      to_address: optAddress(o.to_address, "to_address", action),
      slippage_bps: slippage(o.slippage_bps, action),
    },
    venue,
  };
}

function blank(venue: BridgeQuote["venue"], r: BridgeRequest, as_of: string, error: string): BridgeQuote {
  return {
    venue, lane: "cross-chain", from_chain: r.from_chain, to_chain: r.to_chain, from_token: r.from_token, to_token: r.to_token,
    from_amount: r.from_amount, to_amount: null, to_amount_min: null, route_via: null, est_duration_s: null,
    sato_fee_bps: venue === "sato" ? null : 0, sato_fee_recipient: null,
    fee_disclosure: venue === "sato" ? "unknown: the Sato Route response could not be read, so no fee sentence is available" : NO_SATO_FEE_STATEMENT,
    upstream_fees: null, from_usd: null, tx: null, error, as_of,
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

/** Sato Route cross-chain lane: POST /api/swap/quote with chain_out set. */
export async function satoBridgeQuote(ctx: ActionContext, r: BridgeRequest, mode: "recommend" | "build-tx", as_of: string): Promise<BridgeQuote> {
  const body: Record<string, unknown> = {
    chain_in: r.from_chain, chain_out: r.to_chain, token_in: r.from_token, token_out: r.to_token, amount_in: r.from_amount,
    slippage_bps: r.slippage_bps, mode,
  };
  if (r.from_address) body.taker = r.from_address;
  if (r.to_address) body.recipient = r.to_address;
  let res;
  try {
    res = await http(ctx, SATO_SWAP_URL, { method: "POST", body });
  } catch (e) {
    return blank("sato", r, as_of, `request_failed: ${errorMessage(e)}`);
  }
  const b = (res.body ?? {}) as Record<string, unknown>;
  if (res.status !== 200) return blank("sato", r, as_of, `http_${res.status}: ${str(b.error) ?? "no body"}`);
  if ("unavailable" in b) return blank("sato", r, as_of, `no_route: ${str(b.caveat) ?? "Sato Route found no cross-chain route for this pair"}`);
  if (b.lane !== "cross-chain") return blank("sato", r, as_of, `lane_mismatch: the response lane was ${str(b.lane) ?? "absent"}, not cross-chain, so it is not shown beside a cross-chain quote`);
  if (typeof b.disclosure !== "string") return blank("sato", r, as_of, "malformed: the response carried no fee disclosure");
  const t = b.tx as Record<string, unknown> | null | undefined;
  const withheld = b.withheld as { reason?: unknown; rule?: unknown } | null | undefined;
  let tx: VenueTx | null = null;
  if (t && typeof t.to === "string" && typeof t.data === "string") {
    tx = {
      to: t.to, data: t.data, value: hexToDec(t.value), gas: str(t.gas),
      chain_id: typeof t.chain_id === "number" ? t.chain_id : EVM_CHAIN_IDS[r.from_chain],
      approval_target: typeof t.approval_target === "string" ? t.approval_target : t.to,
    };
  }
  return {
    venue: "sato", lane: "cross-chain", from_chain: r.from_chain, to_chain: r.to_chain, from_token: r.from_token, to_token: r.to_token,
    from_amount: r.from_amount, to_amount: str(b.amount_out), to_amount_min: null, route_via: str(b.venue), est_duration_s: null,
    sato_fee_bps: typeof b.sato_fee_bps === "number" ? b.sato_fee_bps : null,
    sato_fee_recipient: str(b.sato_fee_recipient),
    fee_disclosure: b.disclosure,
    upstream_fees: null, from_usd: null, tx,
    error: mode === "build-tx" && !tx ? `withheld: ${str(withheld?.rule) ?? "?"} ${str(withheld?.reason) ?? "no transaction returned"}` : null,
    as_of,
  };
}

/** LI.FI GET /v1/quote across chains. Keyless. Its transactionRequest is the source-chain tx. */
export async function lifiBridgeQuote(ctx: ActionContext, r: BridgeRequest, as_of: string): Promise<BridgeQuote> {
  const q = new URLSearchParams({
    fromChain: String(EVM_CHAIN_IDS[r.from_chain]), toChain: String(EVM_CHAIN_IDS[r.to_chain]),
    fromToken: r.from_token, toToken: r.to_token, fromAmount: r.from_amount,
    fromAddress: r.from_address ?? QUOTE_ONLY_FROM, slippage: String(r.slippage_bps / 10_000),
  });
  if (r.to_address) q.set("toAddress", r.to_address);
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
  const tx: VenueTx | null = r.from_address && tr && typeof tr.to === "string" && typeof tr.data === "string"
    ? {
        to: tr.to, data: tr.data, value: hexToDec(tr.value), gas: tr.gasLimit ? hexToDec(tr.gasLimit) : null,
        chain_id: typeof tr.chainId === "number" ? tr.chainId : EVM_CHAIN_IDS[r.from_chain],
        approval_target: str(est.approvalAddress) ?? tr.to,
      }
    : null;
  return {
    venue: "lifi", lane: "cross-chain", from_chain: r.from_chain, to_chain: r.to_chain, from_token: r.from_token, to_token: r.to_token,
    from_amount: r.from_amount, to_amount: str(est.toAmount), to_amount_min: str(est.toAmountMin), route_via: str(b.tool),
    est_duration_s: num(est.executionDuration),
    sato_fee_bps: 0, sato_fee_recipient: null, fee_disclosure: NO_SATO_FEE_STATEMENT,
    upstream_fees: { feeCosts: est.feeCosts ?? null, gasCosts: est.gasCosts ?? null },
    from_usd: num(est.fromAmountUSD), tx, error: null, as_of,
  };
}
