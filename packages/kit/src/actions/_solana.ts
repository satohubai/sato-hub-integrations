// ACTIONS builder (K4). Shared pieces for the Solana actions: clusters, the
// stablecoin mints the USD rule may use, input checks, the RPC accessor and
// the two swap venue clients (Sato Route's Solana lane, and Jupiter directly).
//
// Venue-neutral (scope §0.3): the Sato quote carries Sato's fee sentence
// verbatim; the Jupiter quote is requested with NO platformFeeBps, so no Sato
// fee rides on it. Nothing here orders, scores or compares the two.
import type { OdaChain, PolicyNetwork } from "../spec/index.js";
import type { ActionContext, SolanaCluster, SolanaRpc } from "../types.js";
import { ActionInputError, errorMessage, http } from "./_util.js";
import { SOLANA_PUBKEY_PATTERN, WSOL_MINT, isPubkey } from "../solana/codec.js";

export const SOLANA_CLUSTERS: SolanaCluster[] = ["solana", "solana-devnet"];
/** Jupiter and Sato Route quote on mainnet only. */
export const SOLANA_SWAP_CHAINS: SolanaCluster[] = ["solana"];

export const JUPITER_BASE_URL = "https://lite-api.jup.ag/swap/v1";
export const JUPITER_DOC_URL = "https://dev.jup.ag/docs/swap/add-fees-to-swap";
export const SATO_SWAP_QUOTE_URL = "https://satohub.ai/api/swap/quote";

export const SOLANA_SWAP_VENUES = ["sato", "direct", "jupiter"] as const;
export type SolanaSwapVenue = (typeof SOLANA_SWAP_VENUES)[number];

/**
 * Stablecoin mints per cluster, used only when no venue returned a USD
 * figure. ASSUMPTION stated wherever it is used: 1 unit = 1 USD.
 * Mainnet: Circle USDC and Tether USDT. Devnet: Circle's devnet USDC.
 */
export const SOLANA_STABLECOINS: Record<SolanaCluster, Record<string, { symbol: string; decimals: number }>> = {
  solana: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", decimals: 6 },
  },
  "solana-devnet": {
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": { symbol: "USDC", decimals: 6 },
  },
};

export const pubkeySchema = (description: string) => ({ type: "string", pattern: SOLANA_PUBKEY_PATTERN, description });
export const clusterSchema = (chains: readonly string[]) => ({ type: "string", enum: [...chains], description: "Solana cluster." });

export function cluster(v: unknown, allowed: readonly SolanaCluster[], action: string): SolanaCluster {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new ActionInputError(`${action}: chain must be one of ${allowed.join(", ")}`);
  return v as SolanaCluster;
}

export function pubkey(v: unknown, field: string, action: string): string {
  if (!isPubkey(v)) throw new ActionInputError(`${action}: ${field} must be a base58 Solana public key`);
  return v;
}

/** The network the chain itself is on; the pre-flight compares it with the policy's. */
export function networkOf(chain: SolanaCluster): PolicyNetwork {
  return chain === "solana" ? "mainnet" : "testnet";
}

export function solanaRpcFor(ctx: ActionContext, chain: SolanaCluster, action: string): SolanaRpc {
  if (!ctx.solanaRpc) throw new ActionInputError(`${action}: no Solana RPC configured (pass solanaRpc to createKit, e.g. solanaJsonRpc(url))`);
  return ctx.solanaRpc(chain);
}

export function baseUnitsToNumber(amount: string, decimals: number): number {
  const v = BigInt(amount);
  const d = 10n ** BigInt(decimals);
  return Number(v / d) + Number(v % d) / Number(d);
}

export function stableOf(chain: SolanaCluster, mint: string): { symbol: string; decimals: number } | null {
  return SOLANA_STABLECOINS[chain][mint] ?? null;
}

/** The "chain" value the policy's allow lists see: "solana" or "solana-devnet". */
export const odaChain = (c: SolanaCluster): OdaChain => c;

// ---- swap venues ------------------------------------------------------------
export type SolanaSwapRequest = {
  chain: SolanaCluster;
  input_mint: string;
  output_mint: string;
  amount: string;
  slippage_bps: number;
  taker: string | null;
};

export type SolanaSwapQuote = {
  venue: "sato" | "jupiter";
  chain: SolanaCluster;
  input_mint: string;
  output_mint: string;
  amount: string;
  out_amount: string | null;
  /** Jupiter's otherAmountThreshold (minimum after slippage), or null. */
  out_amount_min: string | null;
  /** Route labels as the venue named them, or null. */
  route_via: string | null;
  /** Sato's fee in bps: the Sato response's own figure for venue sato; 0 on the Jupiter quote. */
  sato_fee_bps: number | null;
  /** The token account the Sato fee is paid into (Jupiter's feeAccount), or null. */
  sato_fee_recipient: string | null;
  /** Sato's fee sentence verbatim for venue sato; a plain statement for jupiter. */
  fee_disclosure: string;
  /** Jupiter's platformFee field as returned, or null. */
  upstream_fees: unknown;
  /** Jupiter's swapUsdValue when it returned one; null otherwise (never estimated here). */
  swap_usd: number | null;
  error: string | null;
  as_of: string;
};

export const NO_SATO_FEE_SOLANA =
  "No Sato fee is added to this quote: it was requested from Jupiter without platformFeeBps. Jupiter's own platformFee field is in upstream_fees exactly as returned.";

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function blank(venue: SolanaSwapQuote["venue"], r: SolanaSwapRequest, as_of: string, error: string): SolanaSwapQuote {
  return {
    venue, chain: r.chain, input_mint: r.input_mint, output_mint: r.output_mint, amount: r.amount,
    out_amount: null, out_amount_min: null, route_via: null,
    sato_fee_bps: venue === "sato" ? null : 0, sato_fee_recipient: null,
    fee_disclosure: venue === "sato" ? "unknown: the Sato Route response could not be read, so no fee sentence is available" : NO_SATO_FEE_SOLANA,
    upstream_fees: null, swap_usd: null, error, as_of,
  };
}

/** Sato Route, POST /api/swap/quote with chain_in "solana", mode recommend. Sato's disclosure is kept verbatim. */
export async function satoSolanaQuote(ctx: ActionContext, r: SolanaSwapRequest, as_of: string): Promise<SolanaSwapQuote> {
  const body: Record<string, unknown> = {
    chain_in: r.chain, token_in: r.input_mint, token_out: r.output_mint, amount_in: r.amount, slippage_bps: r.slippage_bps, mode: "recommend",
  };
  if (r.taker) body.taker = r.taker;
  let res;
  try {
    res = await http(ctx, SATO_SWAP_QUOTE_URL, { method: "POST", body });
  } catch (e) {
    return blank("sato", r, as_of, `request_failed: ${errorMessage(e)}`);
  }
  const b = (res.body ?? {}) as Record<string, unknown>;
  if (res.status !== 200) return blank("sato", r, as_of, `http_${res.status}: ${str(b.error) ?? "no body"}`);
  if ("unavailable" in b) return blank("sato", r, as_of, `no_route: ${str(b.caveat) ?? "Sato Route found no route for this pair"}`);
  if (typeof b.disclosure !== "string") return blank("sato", r, as_of, "malformed: the response carried no fee disclosure");
  return {
    venue: "sato", chain: r.chain, input_mint: r.input_mint, output_mint: r.output_mint, amount: r.amount,
    out_amount: str(b.amount_out), out_amount_min: null, route_via: str(b.venue),
    sato_fee_bps: typeof b.sato_fee_bps === "number" ? b.sato_fee_bps : null,
    sato_fee_recipient: str(b.sato_fee_recipient),
    fee_disclosure: b.disclosure,
    upstream_fees: null, swap_usd: null, error: null, as_of,
  };
}

export function jupiterQuoteUrl(r: SolanaSwapRequest, platformFeeBps: number | null): string {
  const q = new URLSearchParams({ inputMint: r.input_mint, outputMint: r.output_mint, amount: r.amount, slippageBps: String(r.slippage_bps) });
  if (platformFeeBps !== null && platformFeeBps > 0) q.set("platformFeeBps", String(platformFeeBps));
  return `${JUPITER_BASE_URL}/quote?${q.toString()}`;
}

/** Jupiter GET /quote. Returns the parsed quote AND the raw quoteResponse, which POST /swap needs back verbatim. */
export async function jupiterQuote(ctx: ActionContext, r: SolanaSwapRequest, as_of: string, platformFeeBps: number | null = null): Promise<{ quote: SolanaSwapQuote; raw: Record<string, unknown> | null }> {
  let res;
  try {
    res = await http(ctx, jupiterQuoteUrl(r, platformFeeBps));
  } catch (e) {
    return { quote: blank("jupiter", r, as_of, `request_failed: ${errorMessage(e)}`), raw: null };
  }
  const b = (res.body ?? {}) as Record<string, unknown>;
  if (res.status !== 200) return { quote: blank("jupiter", r, as_of, `http_${res.status}: ${str(b.error) ?? str(b.errorCode) ?? "no body"}`), raw: null };
  const out = str(b.outAmount);
  if (!out) return { quote: blank("jupiter", r, as_of, "malformed: Jupiter returned no outAmount"), raw: null };
  const plan = Array.isArray(b.routePlan) ? (b.routePlan as Array<{ swapInfo?: { label?: unknown } }>) : [];
  const labels = plan.map((p) => str(p.swapInfo?.label)).filter(Boolean);
  return {
    quote: {
      venue: "jupiter", chain: r.chain, input_mint: r.input_mint, output_mint: r.output_mint, amount: r.amount,
      out_amount: out, out_amount_min: str(b.otherAmountThreshold), route_via: labels.length ? labels.join("+") : null,
      sato_fee_bps: 0, sato_fee_recipient: null, fee_disclosure: NO_SATO_FEE_SOLANA,
      upstream_fees: b.platformFee ?? null, swap_usd: num(b.swapUsdValue), error: null, as_of,
    },
    raw: b,
  };
}

/** Jupiter POST /swap. Returns Jupiter's UNSIGNED base64 transaction and its lastValidBlockHeight. */
export async function jupiterSwapTx(ctx: ActionContext, quoteResponse: Record<string, unknown>, userPublicKey: string, feeAccount: string | null): Promise<{ transaction_base64: string; last_valid_block_height: number }> {
  const body: Record<string, unknown> = { quoteResponse, userPublicKey, wrapAndUnwrapSol: true };
  if (feeAccount) body.feeAccount = feeAccount;
  const res = await http(ctx, `${JUPITER_BASE_URL}/swap`, { method: "POST", body });
  const b = (res.body ?? {}) as Record<string, unknown>;
  if (res.status !== 200) throw new Error(`Jupiter /swap answered HTTP ${res.status}: ${str(b.error) ?? "no body"}`);
  if (typeof b.swapTransaction !== "string" || !b.swapTransaction) throw new Error("Jupiter /swap returned no swapTransaction");
  const h = b.lastValidBlockHeight;
  if (typeof h !== "number" || !Number.isInteger(h) || h < 0) throw new Error("Jupiter /swap returned no lastValidBlockHeight");
  return { transaction_base64: b.swapTransaction, last_valid_block_height: h };
}

/** Native SOL is named by the wrapped SOL mint on every venue. */
export function normaliseMint(v: unknown, field: string, action: string): string {
  if (v === "SOL") return WSOL_MINT;
  return pubkey(v, field, action);
}
