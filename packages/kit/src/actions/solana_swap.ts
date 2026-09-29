// ACTIONS builder (K4). solana.swap.quote / solana.swap.prepare — venue-neutral
// Solana swaps (scope §0.3).
//
//   venue "sato" (default): Sato Route's Solana lane (fee disclosed verbatim)
//       AND a Jupiter quote requested with no platformFeeBps, side by side in
//       request order, unranked.
//   venue "direct" | "jupiter": Jupiter only. satohub.ai is not called.
//
// prepare returns Jupiter's UNSIGNED swap transaction (POST /swap) as a
// solana_tx. For venue sato the quote is re-requested from Jupiter with the
// platformFeeBps Sato Route stated, and feeAccount set to the Sato fee token
// account Sato Route named: that is how Sato Route's own disclosure says its
// fee is taken on Jupiter. When Sato Route states no fee (0 bps or no
// account), no fee is added. For direct/jupiter no fee account is passed.
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, FeeDisclosure, UnsignedSolanaTx } from "../spec/index.js";
import type { ActionContext, PrepareAction, PrepareBuild, ReadAction, SolanaCluster } from "../types.js";
import { ActionInputError, baseUnits, isoNow, obj, slippage } from "./_util.js";
import {
  JUPITER_BASE_URL, NO_SATO_FEE_SOLANA, SOLANA_SWAP_CHAINS, SOLANA_SWAP_VENUES, baseUnitsToNumber, cluster, clusterSchema,
  jupiterQuote, jupiterSwapTx, networkOf, normaliseMint, pubkey, pubkeySchema, satoSolanaQuote, stableOf,
} from "./_solana.js";
import type { SolanaSwapQuote, SolanaSwapRequest, SolanaSwapVenue } from "./_solana.js";
import { SOLANA_PUBKEY_PATTERN, fromBase64, readTransaction } from "../solana/codec.js";

const QUOTE_ID = "solana.swap.quote";
const PREPARE_ID = "solana.swap.prepare";

export const SOLANA_SWAP_NOTE =
  "Quotes are listed in the order they were requested and are not ranked. Compare out_amount, sato_fee_bps and upstream_fees yourself. A quote is not a fill.";

export const SOLANA_SWAP_QUOTE_FIXTURES = [
  "test/fixtures/sato-swap-recommend.solana.json",
  "test/fixtures/jupiter-quote.solana.json",
];
export const SOLANA_SWAP_PREPARE_FIXTURES = [
  "test/fixtures/sato-swap-recommend.solana.json",
  "test/fixtures/jupiter-quote-fee.solana.json",
  "test/fixtures/jupiter-swap.solana.json",
];

const MINT_PATTERN = `^(${SOLANA_PUBKEY_PATTERN.slice(1, -1)}|SOL)$`;

function swapInputProperties() {
  return {
    chain: clusterSchema(SOLANA_SWAP_CHAINS),
    input_mint: { type: "string", pattern: MINT_PATTERN, description: "Mint to sell (base58), or SOL for native SOL." },
    output_mint: { type: "string", pattern: MINT_PATTERN, description: "Mint to buy (base58), or SOL for native SOL." },
    amount: { type: "string", pattern: "^[0-9]{1,20}$", description: "Amount to sell, in the input mint's base units." },
    taker: pubkeySchema("The public key that would sign the swap (fee payer)."),
    slippage_bps: { type: "integer", minimum: 0, maximum: 5000, description: "Slippage tolerance in basis points. Defaults to 50." },
    venue: {
      type: "string",
      enum: [...SOLANA_SWAP_VENUES],
      description: "sato (the labelled default, returned together with a Jupiter quote carrying no Sato fee) or direct / jupiter (Jupiter only; Sato is not called).",
    },
  };
}

function parse(input: unknown, action: string, requireTaker: boolean): { request: SolanaSwapRequest; venue: SolanaSwapVenue } {
  const o = obj(input, action);
  const chain = cluster(o.chain, SOLANA_SWAP_CHAINS, action);
  const input_mint = normaliseMint(o.input_mint, "input_mint", action);
  const output_mint = normaliseMint(o.output_mint, "output_mint", action);
  if (input_mint === output_mint) throw new ActionInputError(`${action}: input_mint and output_mint are the same`);
  const amount = baseUnits(o.amount, "amount", action);
  if (BigInt(amount) === 0n || BigInt(amount) >= 2n ** 64n) throw new ActionInputError(`${action}: amount must be a positive u64`);
  const venue = (o.venue ?? "sato") as SolanaSwapVenue;
  if (!SOLANA_SWAP_VENUES.includes(venue)) throw new ActionInputError(`${action}: venue must be one of ${SOLANA_SWAP_VENUES.join(", ")}`);
  const taker = requireTaker || (o.taker !== undefined && o.taker !== null) ? pubkey(o.taker, "taker", action) : null;
  return { request: { chain, input_mint, output_mint, amount, slippage_bps: slippage(o.slippage_bps, action), taker }, venue };
}

function quoteItemSchema() {
  return {
    type: "object",
    properties: {
      venue: { type: "string", enum: ["sato", "jupiter"] },
      chain: { type: "string", enum: [...SOLANA_SWAP_CHAINS] },
      input_mint: { type: "string" },
      output_mint: { type: "string" },
      amount: { type: "string", pattern: "^[0-9]{1,20}$" },
      out_amount: { description: "Base units the venue quoted, or null." },
      out_amount_min: { description: "Minimum after slippage when the venue states it, or null." },
      route_via: { description: "The venue or route labels, or null." },
      sato_fee_bps: { description: "Sato's fee in basis points; 0 on the Jupiter quote." },
      sato_fee_recipient: { description: "The token account the Sato fee is paid into, or null." },
      fee_disclosure: { type: "string", description: "Sato's fee sentence verbatim, or the statement that no Sato fee is added." },
      upstream_fees: { description: "Jupiter's platformFee field as returned, or null." },
      swap_usd: { description: "Jupiter's swapUsdValue when returned, else null." },
      error: { description: "Why this quote is missing or partial, or null." },
      as_of: { type: "string" },
    },
    required: ["venue", "chain", "amount", "sato_fee_bps", "fee_disclosure", "error", "as_of"],
  };
}

export function solanaSwapQuoteDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: QUOTE_ID,
    name: odaIdToToolName(QUOTE_ID),
    version: "0.1.0",
    title: "Quote a Solana swap",
    description:
      "Returns swap quotes for selling one Solana token for another. By default it returns the Sato Route quote, whose fee is disclosed in the response, together with a Jupiter quote that carries no Sato fee, side by side and unranked. Set venue to direct or jupiter for the Jupiter quote alone (Sato is not contacted). Quotes only: nothing is signed or sent.",
    effects: ["quote"],
    custody: { reads_key: false, sends_key: false, moves_funds: "never" },
    chains: [...SOLANA_SWAP_CHAINS],
    input_schema: {
      type: "object",
      properties: swapInputProperties(),
      required: ["chain", "input_mint", "output_mint", "amount"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        quotes: { type: "array", items: quoteItemSchema() },
        order: { type: "string", enum: ["as_requested"] },
        note: { type: "string" },
        as_of: { type: "string" },
      },
      required: ["quotes", "order", "note", "as_of"],
    },
    policy: { rules: [] },
    receipt: false,
    fixtures: [...SOLANA_SWAP_QUOTE_FIXTURES],
    upstream: {},
    sponsored: null,
  };
}

export type SolanaSwapQuoteOutput = { quotes: SolanaSwapQuote[]; order: "as_requested"; note: string; as_of: string };

export async function solanaSwapQuote(input: unknown, ctx: ActionContext): Promise<SolanaSwapQuoteOutput> {
  const { request, venue } = parse(input, QUOTE_ID, false);
  const as_of = isoNow(ctx);
  const quotes = venue === "sato"
    ? await Promise.all([satoSolanaQuote(ctx, request, as_of), jupiterQuote(ctx, request, as_of).then((j) => j.quote)])
    : [(await jupiterQuote(ctx, request, as_of)).quote];
  return { quotes, order: "as_requested", note: SOLANA_SWAP_NOTE, as_of };
}

export function solanaSwapQuoteAction(): ReadAction<unknown, SolanaSwapQuoteOutput> {
  return { descriptor: solanaSwapQuoteDescriptor(), run: solanaSwapQuote };
}

// ---- prepare ------------------------------------------------------------------

export type SolanaSwapPrepareParams = {
  chain: SolanaCluster;
  input_mint: string;
  output_mint: string;
  amount: string;
  taker: string;
  slippage_bps: number;
  venue: "sato" | "jupiter";
  /** Who built the transaction: always Jupiter's POST /swap. */
  built_by: string;
  route_via: string | null;
  out_amount: string | null;
  out_amount_min: string | null;
  sato_fee_bps: number;
  fee_account: string | null;
  recent_blockhash: string;
  last_valid_block_height: number;
  usd_value: number | null;
  usd_value_source: string;
};

/** USD value, honestly: Jupiter's swapUsdValue; else a stablecoin leg at 1 unit = 1 USD; else null. */
export function deriveSolanaUsd(chain: SolanaCluster, q: Pick<SolanaSwapQuote, "input_mint" | "output_mint" | "amount" | "out_amount" | "swap_usd">): { usd_value: number | null; source: string } {
  if (q.swap_usd !== null && Number.isFinite(q.swap_usd)) return { usd_value: q.swap_usd, source: "venue: jupiter returned swapUsdValue" };
  const sell = stableOf(chain, q.input_mint);
  if (sell) return { usd_value: baseUnitsToNumber(q.amount, sell.decimals), source: `stablecoin leg: amount of ${sell.symbol} / 10^${sell.decimals}, assuming 1 ${sell.symbol} = 1 USD` };
  const buy = stableOf(chain, q.output_mint);
  if (buy && q.out_amount && /^[0-9]+$/.test(q.out_amount)) {
    return { usd_value: baseUnitsToNumber(q.out_amount, buy.decimals), source: `stablecoin leg: quoted out_amount of ${buy.symbol} / 10^${buy.decimals}, assuming 1 ${buy.symbol} = 1 USD` };
  }
  return { usd_value: null, source: "unknown: no venue returned a USD value and neither leg is a listed stablecoin" };
}

export function solanaSwapPrepareDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: PREPARE_ID,
    name: odaIdToToolName(PREPARE_ID),
    version: "0.1.0",
    title: "Prepare a Solana swap",
    description:
      "Builds the unsigned Solana swap transaction from Jupiter for the venue you choose: sato (the labelled default; the transaction carries the Sato fee that Sato Route states, and its fee sentence is quoted verbatim) or direct / jupiter (no Sato fee; Sato is not contacted). It returns an intent to review and runs the policy pre-flight and a simulation; nothing moves until execute hands it to your signer.",
    effects: ["quote", "sign", "broadcast"],
    custody: { reads_key: false, sends_key: false, moves_funds: "with_approval" },
    chains: [...SOLANA_SWAP_CHAINS],
    input_schema: {
      type: "object",
      properties: swapInputProperties(),
      required: ["chain", "input_mint", "output_mint", "amount", "taker"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      description: "A PreparedIntent (sato.action/v1 intent shape) whose unsigned payload is a solana_tx.",
      properties: {
        intent_id: { type: "string", pattern: "^si_[A-Za-z0-9_-]{43}$" },
        action: { type: "string" },
        expires_at: { type: "string" },
        summary: { type: "string" },
        policy: { type: "object" },
        simulation: { description: "SimulationResult from simulateTransaction, or null when the policy refused first." },
        fee_disclosure: { description: "FeeDisclosure for the chosen venue." },
        unsigned: { type: "object", description: "UnsignedSolanaTx built by Jupiter." },
      },
      required: ["intent_id", "action", "expires_at", "summary", "policy", "simulation", "fee_disclosure", "unsigned"],
    },
    policy: {
      rules: [
        "network_mainnet_not_enabled", "chain_allowlist", "token_allowlist", "venue_allowlist",
        "max_per_trade", "max_usd_per_trade", "max_usd_per_day", "unknown_price", "max_slippage_bps", "intent_ttl",
        "simulation_required", "simulation_failed",
      ],
    },
    receipt: true,
    fixtures: [...SOLANA_SWAP_PREPARE_FIXTURES],
    upstream: {},
    sponsored: null,
  };
}

export async function buildSolanaSwapPrepare(input: unknown, ctx: ActionContext): Promise<PrepareBuild> {
  const { request, venue: asked } = parse(input, PREPARE_ID, true);
  const taker = request.taker as string;
  const as_of = isoNow(ctx);
  const venue: "sato" | "jupiter" = asked === "sato" ? "sato" : "jupiter";

  let feeBps = 0;
  let feeAccount: string | null = null;
  let disclosure: FeeDisclosure;
  if (venue === "sato") {
    const s = await satoSolanaQuote(ctx, request, as_of);
    if (s.error) throw new Error(`${PREPARE_ID}: sato returned no usable quote (${s.error}); choose venue direct for the Jupiter quote without Sato`);
    if (s.sato_fee_bps !== null && s.sato_fee_bps > 0 && s.sato_fee_recipient) {
      feeBps = s.sato_fee_bps;
      feeAccount = s.sato_fee_recipient;
    }
    disclosure = { venue: "sato", fee_bps: s.sato_fee_bps, fee_recipient: s.sato_fee_recipient, statement: s.fee_disclosure, direct_quote_available: true };
  } else {
    disclosure = { venue: "jupiter", fee_bps: null, fee_recipient: null, statement: NO_SATO_FEE_SOLANA, direct_quote_available: true };
  }

  const { quote, raw } = await jupiterQuote(ctx, request, as_of, feeBps > 0 ? feeBps : null);
  if (quote.error || !raw) throw new Error(`${PREPARE_ID}: Jupiter returned no quote — ${quote.error ?? "no body"}; nothing was prepared`);
  if (venue === "jupiter") disclosure = { ...disclosure, statement: quote.upstream_fees ? `${NO_SATO_FEE_SOLANA} platformFee as returned: ${JSON.stringify(quote.upstream_fees)}.` : NO_SATO_FEE_SOLANA };
  const built = await jupiterSwapTx(ctx, raw, taker, feeAccount);

  let summaryTx;
  try {
    summaryTx = readTransaction(fromBase64(built.transaction_base64));
  } catch (e) {
    throw new Error(`${PREPARE_ID}: Jupiter's transaction could not be read (${(e as Error).message}); nothing was prepared`);
  }
  if (summaryTx.fee_payer !== taker) throw new Error(`${PREPARE_ID}: Jupiter's transaction names fee payer ${summaryTx.fee_payer}, not the taker ${taker}; nothing was prepared`);

  const unsigned: UnsignedSolanaTx = {
    kind: "solana_tx",
    chain: request.chain,
    fee_payer: taker,
    transaction_base64: built.transaction_base64,
    recent_blockhash: summaryTx.recent_blockhash,
    last_valid_block_height: built.last_valid_block_height,
  };
  const usd = deriveSolanaUsd(request.chain, quote);
  const params: SolanaSwapPrepareParams = {
    chain: request.chain, input_mint: request.input_mint, output_mint: request.output_mint, amount: request.amount, taker,
    slippage_bps: request.slippage_bps, venue, built_by: `${JUPITER_BASE_URL}/swap`, route_via: quote.route_via,
    out_amount: quote.out_amount, out_amount_min: quote.out_amount_min, sato_fee_bps: feeBps, fee_account: feeAccount,
    recent_blockhash: unsigned.recent_blockhash, last_valid_block_height: unsigned.last_valid_block_height,
    usd_value: usd.usd_value, usd_value_source: usd.source,
  };
  const feeWord = venue === "sato"
    ? feeBps > 0 ? `Sato fee ${feeBps} bps paid into ${feeAccount} (see fee_disclosure)` : "Sato Route stated no fee for this pair, so none is added (see fee_disclosure)"
    : "no Sato fee";
  const summary = `Swap ${request.amount} base units of ${request.input_mint} for ${request.output_mint} on ${request.chain} via ${venue}; transaction built by Jupiter${quote.route_via ? ` (${quote.route_via})` : ""}; quoted ${quote.out_amount ?? "unknown"}${quote.out_amount_min ? `, minimum ${quote.out_amount_min}` : ""} base units; ${feeWord}. Valid until block height ${unsigned.last_valid_block_height}. USD value: ${usd.usd_value ?? "unknown"} (${usd.source}).`;

  return {
    params,
    unsigned,
    facts: {
      action: PREPARE_ID,
      chain: request.chain,
      network: networkOf(request.chain),
      token: request.input_mint,
      token_amount_base_units: request.amount,
      usd_value: usd.usd_value,
      usd_spent_today: null,
      venue,
      slippage_bps: request.slippage_bps,
    },
    summary,
    fee_disclosure: disclosure,
  };
}

export function solanaSwapPrepareAction(): PrepareAction {
  return { descriptor: solanaSwapPrepareDescriptor(), build: buildSolanaSwapPrepare };
}
