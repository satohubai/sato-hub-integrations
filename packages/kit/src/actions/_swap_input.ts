// ACTIONS builder. The swap input shared by swap.quote and swap.prepare.
import type { ActionContext } from "../types.js";
import { ActionInputError, SWAP_CHAINS, address, baseUnits, chainSchema, evmChain, obj, optAddress, slippage } from "./_util.js";
import { SWAP_VENUES } from "./_venues.js";
import type { SwapRequest, SwapVenue } from "./_venues.js";

export const TOKEN_PATTERN = "^(0x[0-9a-fA-F]{40}|[A-Za-z0-9.]{1,20})$";
const TOKEN_RE = new RegExp(TOKEN_PATTERN);

export type ParsedSwapInput = { request: SwapRequest; venue: SwapVenue; zeroexKey: string | null };

/** Structural: a host may hand a 0x key on the context without the shared type knowing it. */
type ZeroexCtx = { zeroexApiKey?: unknown };

export function swapInputProperties() {
  return {
    chain: chainSchema(SWAP_CHAINS),
    sell_token: { type: "string", pattern: TOKEN_PATTERN, description: "Token to sell: a 0x address or a symbol." },
    buy_token: { type: "string", pattern: TOKEN_PATTERN, description: "Token to buy: a 0x address or a symbol." },
    sell_amount: { type: "string", pattern: "^[0-9]{1,78}$", description: "Amount to sell, in base units, as a decimal string." },
    taker: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Address that would sign the swap." },
    slippage_bps: { type: "integer", minimum: 0, maximum: 5000, description: "Slippage tolerance in basis points. Defaults to 50." },
    venue: {
      type: "string",
      enum: [...SWAP_VENUES],
      description: "sato (the labelled default, returned together with a quote carrying no Sato fee), direct or lifi (LI.FI only; Sato is not called), 0x (0x only; needs zeroex_api_key).",
    },
    zeroex_api_key: { type: "string", description: "0x API key, used only when venue is 0x. Never stored or digested." },
  };
}

export function parseSwapInput(input: unknown, ctx: ActionContext, action: string, requireTaker: boolean): ParsedSwapInput {
  const o = obj(input, action);
  const chain = evmChain(o.chain, SWAP_CHAINS, action);
  for (const f of ["sell_token", "buy_token"] as const) {
    if (typeof o[f] !== "string" || !TOKEN_RE.test(o[f] as string)) throw new ActionInputError(`${action}: ${f} must be a 0x address or a token symbol`);
  }
  const venue = (o.venue ?? "sato") as SwapVenue;
  if (!SWAP_VENUES.includes(venue)) throw new ActionInputError(`${action}: venue must be one of ${SWAP_VENUES.join(", ")}`);
  const taker = requireTaker ? address(o.taker, "taker", action) : optAddress(o.taker, "taker", action);
  const fromInput = typeof o.zeroex_api_key === "string" && o.zeroex_api_key ? o.zeroex_api_key : null;
  const fromCtx = (ctx as ActionContext & ZeroexCtx).zeroexApiKey;
  const zeroexKey = fromInput ?? (typeof fromCtx === "string" && fromCtx ? fromCtx : null);
  if (venue === "0x" && !zeroexKey) {
    throw new ActionInputError(`${action}: venue 0x needs a 0x API key — pass zeroex_api_key in the input or zeroexApiKey on the context, or choose another venue`);
  }
  return {
    request: {
      chain,
      sell_token: o.sell_token as string,
      buy_token: o.buy_token as string,
      sell_amount: baseUnits(o.sell_amount, "sell_amount", action),
      taker,
      slippage_bps: slippage(o.slippage_bps, action),
    },
    venue,
    zeroexKey,
  };
}
