// ACTIONS builder. swap.prepare — build the unsigned transaction for a swap on
// the venue the caller chose. Nothing here holds a key: the output is an
// UnsignedEvmTx the kit turns into an intent, and only execute (with a
// signer) can move funds, hence moves_funds "with_approval".
//
// APPROVAL, KEPT SIMPLE: when the taker's ERC-20 allowance to the venue's
// spender is below sell_amount, this prepare returns the APPROVE transaction
// (exact amount, never unlimited) as the intent's unsigned payload and says so
// in the summary and params.step. Once that approval has landed, preparing the
// swap again returns the swap itself. One intent is one transaction.
//
// Venue-neutral (scope §0.3): venue "sato" is the labelled default and its fee
// sentence is quoted verbatim; "direct"/"lifi" and "0x" never call Sato.
import { encodeFunctionData, erc20Abi } from "viem";
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, FeeDisclosure, UnsignedEvmTx } from "../spec/index.js";
import type { ActionContext, PrepareAction, PrepareBuild } from "../types.js";
import { ActionInputError, EVM_CHAIN_IDS, SWAP_CHAINS, VIEM_PIN, classifyRpcError, isoNow } from "./_util.js";
import { NO_SATO_FEE_STATEMENT, lifiQuote, satoQuote, zeroexQuote } from "./_venues.js";
import type { SwapQuote } from "./_venues.js";
import { parseSwapInput, swapInputProperties } from "./_swap_input.js";

const ID = "swap.prepare";

const NATIVE = new Set(["0x0000000000000000000000000000000000000000", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]);
const NATIVE_SYMBOLS = new Set(["ETH", "POL", "MATIC"]);

export const SWAP_PREPARE_FIXTURES = [
  "test/fixtures/sato-swap-build-tx.base.json",
  "test/fixtures/lifi-quote.base.json",
];

export type SwapPrepareParams = {
  step: "approve" | "swap";
  chain: string;
  sell_token: string;
  buy_token: string;
  sell_amount: string;
  taker: string;
  slippage_bps: number;
  venue: "sato" | "lifi" | "0x";
  route_via: string | null;
  buy_amount: string | null;
  /** The trade's USD value handed to the pre-flight; null = unknown. */
  usd_value: number | null;
  /** Where usd_value came from, including the assumption it rests on. */
  usd_value_source: string;
};

/**
 * Stablecoins per swap chain (address lowercased -> symbol, decimals). Used only
 * when the venue returned no USD figure. ASSUMPTION stated wherever it is used:
 * one unit of the stablecoin is valued at 1 USD.
 */
export const STABLECOINS: Record<string, Record<string, { symbol: string; decimals: number }>> = {
  ethereum: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
    "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18 },
  },
  base: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
    "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": { symbol: "USDT", decimals: 6 },
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI", decimals: 18 },
  },
  arbitrum: {
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6 },
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6 },
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18 },
  },
  optimism: {
    "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { symbol: "USDC", decimals: 6 },
    "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": { symbol: "USDT", decimals: 6 },
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18 },
  },
  polygon: {
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6 },
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT", decimals: 6 },
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": { symbol: "DAI", decimals: 18 },
  },
};

function stableOf(chain: string, token: string): { symbol: string; decimals: number } | null {
  return STABLECOINS[chain]?.[token.toLowerCase()] ?? null;
}

function baseUnitsToNumber(amount: string, decimals: number): number {
  const v = BigInt(amount);
  const d = 10n ** BigInt(decimals);
  return Number(v / d) + Number(v % d) / Number(d);
}

/**
 * The trade's USD value, honestly: the venue's own USD field when it returned
 * one; else a stablecoin leg (sell leg first, then the quoted buy amount) at
 * the stated 1-unit = 1-USD assumption; else null (unknown stays unknown).
 */
export function deriveUsdValue(q: Pick<SwapQuote, "venue" | "chain" | "sell_token" | "buy_token" | "sell_amount" | "buy_amount" | "sell_usd">): { usd_value: number | null; source: string } {
  if (q.sell_usd !== null && Number.isFinite(q.sell_usd)) {
    return { usd_value: q.sell_usd, source: `venue: ${q.venue} returned the sell side's USD value` };
  }
  const sell = stableOf(q.chain, q.sell_token);
  if (sell) {
    return {
      usd_value: baseUnitsToNumber(q.sell_amount, sell.decimals),
      source: `stablecoin leg: sell_amount of ${sell.symbol} / 10^${sell.decimals}, assuming 1 ${sell.symbol} = 1 USD`,
    };
  }
  const buy = stableOf(q.chain, q.buy_token);
  if (buy && q.buy_amount && /^[0-9]+$/.test(q.buy_amount)) {
    return {
      usd_value: baseUnitsToNumber(q.buy_amount, buy.decimals),
      source: `stablecoin leg: quoted buy_amount of ${buy.symbol} / 10^${buy.decimals}, assuming 1 ${buy.symbol} = 1 USD`,
    };
  }
  return { usd_value: null, source: "unknown: the venue returned no USD value and neither leg is a listed stablecoin" };
}

export function swapPrepareDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Prepare a swap",
    description:
      "Builds the unsigned transaction for a swap on the venue you choose: sato (the labelled default, fee disclosed in the response), direct or lifi (no Sato fee; Sato is not contacted), or 0x with an API key. If the taker's token allowance to the venue is short, it prepares the exact-amount approval first and says so; prepare again once it lands. It returns an intent to review and runs the policy pre-flight; nothing moves until execute hands it to your signer, which is where limits are enforced.",
    effects: ["quote", "sign", "broadcast"],
    custody: { reads_key: false, sends_key: false, moves_funds: "with_approval" },
    chains: [...SWAP_CHAINS],
    input_schema: {
      type: "object",
      properties: swapInputProperties(),
      required: ["chain", "sell_token", "buy_token", "sell_amount", "taker"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      description: "A PreparedIntent (sato.action/v1 intent shape).",
      properties: {
        intent_id: { type: "string", pattern: "^si_[A-Za-z0-9_-]{43}$" },
        action: { type: "string" },
        expires_at: { type: "string" },
        summary: { type: "string" },
        policy: { type: "object" },
        simulation: { description: "SimulationResult, or null when the policy refused first." },
        fee_disclosure: { description: "FeeDisclosure for the chosen venue." },
        unsigned: { type: "object", description: "UnsignedEvmTx: the approval or the swap." },
      },
      required: ["intent_id", "action", "expires_at", "summary", "policy", "simulation", "fee_disclosure", "unsigned"],
    },
    policy: {
      rules: [
        "network_mainnet_not_enabled", "chain_allowlist", "token_allowlist", "contract_allowlist", "venue_allowlist",
        "max_per_trade", "max_usd_per_trade", "max_usd_per_day", "unknown_price", "max_slippage_bps", "intent_ttl",
        "simulation_required", "simulation_failed",
      ],
    },
    receipt: true,
    fixtures: [...SWAP_PREPARE_FIXTURES],
    upstream: { ...VIEM_PIN },
    sponsored: null,
  };
}

export function feeText(q: Pick<SwapQuote, "upstream_fees" | "venue">): string {
  const f = q.upstream_fees as { feeCosts?: unknown } | Record<string, unknown> | null;
  if (!f) return NO_SATO_FEE_STATEMENT;
  const parts: string[] = [];
  const costs = (f as { feeCosts?: unknown }).feeCosts;
  if (Array.isArray(costs)) {
    for (const c of costs as Array<Record<string, unknown>>) {
      const tok = (c.token ?? {}) as Record<string, unknown>;
      parts.push(`${String(c.name ?? "fee")}: ${String(c.amount ?? "?")} base units of ${String(tok.symbol ?? tok.address ?? "?")}${c.included === true ? " (included in the quote)" : ""}`);
    }
  } else {
    for (const [k, v] of Object.entries(f)) {
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        parts.push(`${k}: ${String(o.amount ?? "?")} base units of ${String(o.token ?? "?")}`);
      }
    }
  }
  return parts.length ? `${NO_SATO_FEE_STATEMENT} As returned by ${q.venue}: ${parts.join("; ")}.` : NO_SATO_FEE_STATEMENT;
}

function disclosureFor(q: SwapQuote, directAvailable: boolean): FeeDisclosure {
  if (q.venue === "sato") {
    return { venue: "sato", fee_bps: q.sato_fee_bps, fee_recipient: q.sato_fee_recipient, statement: q.fee_disclosure, direct_quote_available: directAvailable };
  }
  // No Sato fee here. fee_bps is null because the venue states its fees as amounts, not a rate.
  return { venue: q.venue, fee_bps: null, fee_recipient: null, statement: feeText(q), direct_quote_available: true };
}

export async function buildSwapPrepare(input: unknown, ctx: ActionContext): Promise<PrepareBuild> {
  const { request, venue: asked, zeroexKey } = parseSwapInput(input, ctx, ID, true);
  const taker = request.taker as `0x${string}`;
  const sellLower = request.sell_token.toLowerCase();
  const native = NATIVE.has(sellLower) || NATIVE_SYMBOLS.has(request.sell_token.toUpperCase());
  if (!native && !request.sell_token.startsWith("0x")) {
    throw new ActionInputError(`${ID}: sell_token must be the token's 0x address so its allowance can be read`);
  }
  const as_of = isoNow(ctx);
  const venue: "sato" | "lifi" | "0x" = asked === "direct" ? "lifi" : asked;

  let chosen: SwapQuote;
  let directAvailable = true;
  if (venue === "sato") {
    const [s, d] = await Promise.all([satoQuote(ctx, request, "build-tx", as_of), lifiQuote(ctx, request, as_of)]);
    chosen = s;
    directAvailable = d.error === null && d.buy_amount !== null;
  } else if (venue === "0x") {
    chosen = await zeroexQuote(ctx, request, zeroexKey as string, "quote", as_of);
  } else {
    chosen = await lifiQuote(ctx, request, as_of);
  }
  if (chosen.error || !chosen.tx) {
    throw new Error(`${ID}: ${venue} returned no executable transaction — ${chosen.error ?? "no transaction in the response"}`);
  }
  const tx = chosen.tx;
  const chain_id = EVM_CHAIN_IDS[request.chain];

  let step: "approve" | "swap" = "swap";
  let unsigned: UnsignedEvmTx = { kind: "evm_tx", chain: request.chain, chain_id, from: taker, to: tx.to, data: tx.data, value: tx.value };
  const spender = (tx.approval_target ?? tx.to) as `0x${string}`;
  if (!native) {
    let allowance: bigint;
    try {
      allowance = await ctx.rpc(request.chain).readContract({
        address: request.sell_token as `0x${string}`, abi: erc20Abi, functionName: "allowance", args: [taker, spender],
      });
    } catch (e) {
      throw new Error(`${ID}: could not read the taker's allowance (${classifyRpcError(e).reason}); nothing was prepared`);
    }
    if (allowance < BigInt(request.sell_amount)) {
      step = "approve";
      unsigned = {
        kind: "evm_tx", chain: request.chain, chain_id, from: taker, to: request.sell_token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, BigInt(request.sell_amount)] }),
        value: "0",
      };
    }
  }

  const usd = deriveUsdValue(chosen);
  const params: SwapPrepareParams = {
    step, chain: request.chain, sell_token: request.sell_token, buy_token: request.buy_token, sell_amount: request.sell_amount,
    taker, slippage_bps: request.slippage_bps, venue, route_via: chosen.route_via, buy_amount: chosen.buy_amount,
    usd_value: usd.usd_value, usd_value_source: usd.source,
  };
  const feeWord = chosen.venue === "sato" ? `Sato fee ${chosen.sato_fee_bps ?? "unknown"} bps (see fee_disclosure)` : "no Sato fee";
  const summary = step === "approve"
    ? `Approve ${spender} to spend exactly ${request.sell_amount} base units of ${request.sell_token} on ${request.chain}, the first step of a swap via ${venue}; prepare the swap again after this lands.`
    : `Swap ${request.sell_amount} base units of ${request.sell_token} for ${request.buy_token} on ${request.chain} via ${venue}${chosen.route_via ? ` (${chosen.route_via})` : ""}; quoted ${chosen.buy_amount ?? "unknown"}${chosen.buy_amount_min ? `, minimum ${chosen.buy_amount_min}` : ""} base units; ${feeWord}. USD value: ${usd.usd_value ?? "unknown"} (${usd.source}).`;

  return {
    params,
    unsigned,
    facts: {
      action: ID,
      chain: request.chain,
      network: ctx.policy.network,
      token: request.sell_token,
      token_amount_base_units: request.sell_amount,
      usd_value: usd.usd_value,
      // Filled by the kit from the receipt log (executed receipts, current UTC day).
      usd_spent_today: null,
      contract: unsigned.to,
      venue,
      slippage_bps: request.slippage_bps,
    },
    summary,
    fee_disclosure: disclosureFor(chosen, directAvailable),
  };
}

export function swapPrepareAction(): PrepareAction {
  return { descriptor: swapPrepareDescriptor(), build: buildSwapPrepare };
}
