// ACTIONS builder. bridge.quote — venue-neutral cross-chain quotes (scope §0.3),
// modelled on swap.quote.
//
//   venue "sato" (default): Sato Route's cross-chain lane in recommend mode AND
//       a LI.FI quote with no Sato fee, side by side in request order. Sato's
//       fee sentence and figure are passed through verbatim from its response.
//   venue "direct" | "lifi": LI.FI only. Sato is not called at all.
//
// No ranking field, no ordering by price: `order` is always "as_requested".
// Only cross-chain quotes appear here; same-chain quotes are swap.quote's and
// are never listed beside these.
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor } from "../spec/index.js";
import type { ActionContext, ReadAction } from "../types.js";
import { SWAP_CHAINS, isoNow } from "./_util.js";
import { bridgeInputProperties, lifiBridgeQuote, parseBridgeInput, satoBridgeQuote } from "./_bridge.js";
import type { BridgeQuote } from "./_bridge.js";

const ID = "bridge.quote";

export type BridgeQuoteOutput = {
  quotes: BridgeQuote[];
  order: "as_requested";
  lane: "cross-chain";
  note: string;
  as_of: string;
};

export const BRIDGE_QUOTE_NOTE =
  "Cross-chain quotes only, listed in the order they were requested and not ranked. Compare to_amount, sato_fee_bps, upstream_fees and est_duration_s yourself. A quote is not a fill, and same-chain quotes are never listed beside these.";

export const BRIDGE_QUOTE_FIXTURES = [
  "test/fixtures/sato-bridge-recommend.base-arbitrum.json",
  "test/fixtures/lifi-quote.bridge.base-arbitrum.json",
];

function quoteItemSchema() {
  return {
    type: "object",
    properties: {
      venue: { type: "string", enum: ["sato", "lifi"] },
      lane: { type: "string", enum: ["cross-chain"] },
      from_chain: { type: "string", enum: [...SWAP_CHAINS] },
      to_chain: { type: "string", enum: [...SWAP_CHAINS] },
      from_token: { type: "string" },
      to_token: { type: "string" },
      from_amount: { type: "string", pattern: "^[0-9]{1,78}$" },
      to_amount: { description: "Base units on the destination chain the venue quoted, or null." },
      to_amount_min: { description: "Minimum after slippage when the venue states it, or null." },
      route_via: { description: "The bridge or tool the venue routed through, or null." },
      est_duration_s: { description: "Seconds the venue estimates the transfer takes, or null." },
      sato_fee_bps: { description: "Sato's fee in basis points as its response states it; 0 on every quote not from Sato." },
      sato_fee_recipient: { description: "Where the Sato fee goes, or null." },
      fee_disclosure: { type: "string", description: "Sato's fee sentence verbatim, or the statement that no Sato fee is added." },
      upstream_fees: { description: "The venue's own fee fields as returned, or null." },
      from_usd: { description: "USD value of the source side when the venue returned one, else null." },
      tx: { description: "Always null on a quote." },
      error: { description: "Why this quote is missing or partial, or null." },
      as_of: { type: "string" },
    },
    required: ["venue", "lane", "from_chain", "to_chain", "from_amount", "sato_fee_bps", "fee_disclosure", "error", "as_of"],
  };
}

export function bridgeQuoteDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Quote a bridge",
    description:
      "Returns cross-chain quotes for moving a token from one EVM chain to another. By default it returns the Sato Route cross-chain quote, whose fee is disclosed in the response, together with a LI.FI quote that carries no Sato fee, side by side and unranked. Set venue to direct or lifi for the no-Sato-fee quote alone (Sato is not contacted). Quotes only: nothing is signed or sent.",
    effects: ["quote"],
    custody: { reads_key: false, sends_key: false, moves_funds: "never" },
    chains: [...SWAP_CHAINS],
    input_schema: {
      type: "object",
      properties: bridgeInputProperties(),
      required: ["from_chain", "to_chain", "from_token", "to_token", "from_amount"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        quotes: { type: "array", items: quoteItemSchema() },
        order: { type: "string", enum: ["as_requested"] },
        lane: { type: "string", enum: ["cross-chain"] },
        note: { type: "string" },
        as_of: { type: "string" },
      },
      required: ["quotes", "order", "lane", "note", "as_of"],
    },
    policy: { rules: [] },
    receipt: false,
    fixtures: [...BRIDGE_QUOTE_FIXTURES],
    upstream: {},
    sponsored: null,
  };
}

export async function bridgeQuote(input: unknown, ctx: ActionContext): Promise<BridgeQuoteOutput> {
  const { request, venue } = parseBridgeInput(input, ID, false);
  const as_of = isoNow(ctx);
  const quotes = venue === "sato"
    ? await Promise.all([satoBridgeQuote(ctx, request, "recommend", as_of), lifiBridgeQuote(ctx, request, as_of)])
    : [await lifiBridgeQuote(ctx, request, as_of)];
  // A quote never carries a transaction; bridge.prepare builds one.
  return { quotes: quotes.map((q) => ({ ...q, tx: null })), order: "as_requested", lane: "cross-chain", note: BRIDGE_QUOTE_NOTE, as_of };
}

export function bridgeQuoteAction(): ReadAction<unknown, BridgeQuoteOutput> {
  return { descriptor: bridgeQuoteDescriptor(), run: bridgeQuote };
}
