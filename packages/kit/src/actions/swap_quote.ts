// ACTIONS builder. swap.quote — venue-neutral swap quotes (scope §0.3).
//
//   venue "sato" (default): Sato Swap in recommend mode AND a LI.FI quote with
//       no Sato fee, returned side by side in request order. Sato's fee
//       sentence is passed through verbatim.
//   venue "direct" | "lifi": LI.FI only. Sato is not called at all.
//   venue "0x": 0x only, and only with a 0x API key.
//
// There is no ranking field and no ordering by price: `order` is always
// "as_requested". Nothing here penalises a quote that is not Sato's.
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor } from "../spec/index.js";
import type { ActionContext, ReadAction } from "../types.js";
import { SWAP_CHAINS, isoNow } from "./_util.js";
import { lifiQuote, satoQuote, zeroexQuote } from "./_venues.js";
import type { SwapQuote } from "./_venues.js";
import { parseSwapInput, swapInputProperties } from "./_swap_input.js";

const ID = "swap.quote";

export type SwapQuoteOutput = {
  quotes: SwapQuote[];
  order: "as_requested";
  note: string;
  as_of: string;
};

export const SWAP_QUOTE_NOTE =
  "Quotes are listed in the order they were requested and are not ranked. Compare buy_amount, sato_fee_bps and upstream_fees yourself. A quote is not a fill.";

export const SWAP_QUOTE_FIXTURES = [
  "test/fixtures/sato-swap-recommend.base.json",
  "test/fixtures/lifi-quote.base.json",
];

function quoteItemSchema() {
  return {
    type: "object",
    properties: {
      venue: { type: "string", enum: ["sato", "lifi", "0x"] },
      chain: { type: "string", enum: [...SWAP_CHAINS] },
      sell_token: { type: "string" },
      buy_token: { type: "string" },
      sell_amount: { type: "string", pattern: "^[0-9]{1,78}$" },
      buy_amount: { description: "Base units the venue quoted, or null." },
      buy_amount_min: { description: "Minimum after slippage when the venue states it, or null." },
      route_via: { description: "The aggregator or tool the venue routed through, or null." },
      sato_fee_bps: { description: "Sato's fee in basis points; 0 on every quote not from Sato." },
      sato_fee_recipient: { description: "Where the Sato fee goes, or null." },
      fee_disclosure: { type: "string", description: "Sato's fee sentence verbatim, or the statement that no Sato fee is added." },
      upstream_fees: { description: "The venue's own fee fields as returned, or null." },
      sell_usd: { description: "USD value of the sell side when the venue returned one, else null." },
      tx: { description: "Always null on a quote." },
      error: { description: "Why this quote is missing or partial, or null." },
      as_of: { type: "string" },
    },
    required: ["venue", "chain", "sell_amount", "sato_fee_bps", "fee_disclosure", "error", "as_of"],
  };
}

export function swapQuoteDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Quote a swap",
    description:
      "Returns swap quotes for selling one token for another on an EVM chain. By default it returns the Sato Swap quote, whose fee is disclosed in the response, together with a quote that carries no Sato fee, side by side and unranked. Set venue to direct or lifi for the no-Sato-fee quote alone (Sato is not contacted), or 0x with an API key. Quotes only: nothing is signed or sent.",
    effects: ["quote"],
    custody: { reads_key: false, sends_key: false, moves_funds: "never" },
    chains: [...SWAP_CHAINS],
    input_schema: {
      type: "object",
      properties: swapInputProperties(),
      required: ["chain", "sell_token", "buy_token", "sell_amount"],
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
    fixtures: [...SWAP_QUOTE_FIXTURES],
    upstream: {},
    sponsored: null,
  };
}

export async function swapQuote(input: unknown, ctx: ActionContext): Promise<SwapQuoteOutput> {
  const { request, venue, zeroexKey } = parseSwapInput(input, ctx, ID, false);
  const as_of = isoNow(ctx);
  let quotes: SwapQuote[];
  if (venue === "sato") {
    quotes = await Promise.all([satoQuote(ctx, request, "recommend", as_of), lifiQuote(ctx, request, as_of)]);
  } else if (venue === "0x") {
    quotes = [await zeroexQuote(ctx, request, zeroexKey as string, "price", as_of)];
  } else {
    quotes = [await lifiQuote(ctx, request, as_of)];
  }
  // A quote never carries a transaction; swap.prepare builds one.
  return { quotes: quotes.map((q) => ({ ...q, tx: null })), order: "as_requested", note: SWAP_QUOTE_NOTE, as_of };
}

export function swapQuoteAction(): ReadAction<unknown, SwapQuoteOutput> {
  return { descriptor: swapQuoteDescriptor(), run: swapQuote };
}
