// ACTIONS builder. bridge.prepare — build the unsigned SOURCE-CHAIN transaction
// for a cross-chain transfer on the venue the caller chose, modelled on
// swap.prepare. Nothing here holds a key: the output is an UnsignedEvmTx the
// kit turns into an intent (simulate + pre-flight), and only execute(intent_id)
// with a signer can move funds, hence moves_funds "with_approval".
//
// APPROVAL, as swap.prepare: when from_address's ERC-20 allowance to the
// venue's spender is below from_amount, this prepare returns the exact-amount
// APPROVE transaction (never unlimited) and says so in summary and params.step;
// preparing again once it lands returns the bridge transaction. One intent is
// one transaction, and only the source chain is ever signed here.
//
// Venue-neutral (scope §0.3): venue "sato" is the labelled default and its fee
// sentence is quoted verbatim; "direct"/"lifi" never call Sato.
import { encodeFunctionData, erc20Abi } from "viem";
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, FeeDisclosure, UnsignedEvmTx } from "../spec/index.js";
import type { ActionContext, PrepareAction, PrepareBuild } from "../types.js";
import { ActionInputError, EVM_CHAIN_IDS, SWAP_CHAINS, VIEM_PIN, classifyRpcError, isoNow } from "./_util.js";
import { bridgeInputProperties, lifiBridgeQuote, parseBridgeInput, satoBridgeQuote } from "./_bridge.js";
import type { BridgeQuote } from "./_bridge.js";
import { deriveUsdValue, feeText } from "./swap_prepare.js";

const ID = "bridge.prepare";

const NATIVE = new Set(["0x0000000000000000000000000000000000000000", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]);
const NATIVE_SYMBOLS = new Set(["ETH", "POL", "MATIC"]);

export const BRIDGE_PREPARE_FIXTURES = [
  "test/fixtures/sato-bridge-build-tx.base-arbitrum.json",
  "test/fixtures/sato-bridge-build-tx-withheld.base-arbitrum.json",
  "test/fixtures/lifi-quote.bridge.base-arbitrum.json",
];

export type BridgePrepareParams = {
  step: "approve" | "bridge";
  lane: "cross-chain";
  from_chain: string;
  to_chain: string;
  from_token: string;
  to_token: string;
  from_amount: string;
  from_address: string;
  to_address: string;
  slippage_bps: number;
  venue: "sato" | "lifi";
  route_via: string | null;
  to_amount: string | null;
  est_duration_s: number | null;
  usd_value: number | null;
  usd_value_source: string;
};

export function bridgePrepareDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Prepare a bridge",
    description:
      "Builds the unsigned source-chain transaction for a cross-chain transfer on the venue you choose: sato (the labelled default, fee disclosed in the response) or direct / lifi (no Sato fee; Sato is not contacted). If the sender's token allowance to the venue is short, it prepares the exact-amount approval first and says so; prepare again once it lands. It returns an intent to review and runs the policy pre-flight; nothing moves until execute hands it to your signer, which is where limits are enforced.",
    effects: ["quote", "sign", "broadcast"],
    custody: { reads_key: false, sends_key: false, moves_funds: "with_approval" },
    chains: [...SWAP_CHAINS],
    input_schema: {
      type: "object",
      properties: bridgeInputProperties(),
      required: ["from_chain", "to_chain", "from_token", "to_token", "from_amount", "from_address"],
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
        unsigned: { type: "object", description: "UnsignedEvmTx on the source chain: the approval or the bridge transaction." },
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
    fixtures: [...BRIDGE_PREPARE_FIXTURES],
    upstream: { ...VIEM_PIN },
    sponsored: null,
  };
}

function disclosureFor(q: BridgeQuote, directAvailable: boolean): FeeDisclosure {
  if (q.venue === "sato") {
    return { venue: "sato", fee_bps: q.sato_fee_bps, fee_recipient: q.sato_fee_recipient, statement: q.fee_disclosure, direct_quote_available: directAvailable };
  }
  return { venue: q.venue, fee_bps: null, fee_recipient: null, statement: feeText(q), direct_quote_available: true };
}

export async function buildBridgePrepare(input: unknown, ctx: ActionContext): Promise<PrepareBuild> {
  const { request, venue: asked } = parseBridgeInput(input, ID, true);
  const from = request.from_address as `0x${string}`;
  const native = NATIVE.has(request.from_token.toLowerCase()) || NATIVE_SYMBOLS.has(request.from_token.toUpperCase());
  if (!native && !request.from_token.startsWith("0x")) {
    throw new ActionInputError(`${ID}: from_token must be the token's 0x address so its allowance can be read`);
  }
  const as_of = isoNow(ctx);
  const venue: "sato" | "lifi" = asked === "sato" ? "sato" : "lifi";

  let chosen: BridgeQuote;
  let directAvailable = true;
  if (venue === "sato") {
    const [s, d] = await Promise.all([satoBridgeQuote(ctx, request, "build-tx", as_of), lifiBridgeQuote(ctx, request, as_of)]);
    chosen = s;
    directAvailable = d.error === null && d.to_amount !== null;
  } else {
    chosen = await lifiBridgeQuote(ctx, request, as_of);
  }
  if (chosen.error || !chosen.tx) {
    throw new Error(`${ID}: ${venue} returned no executable transaction — ${chosen.error ?? "no transaction in the response"}`);
  }
  const tx = chosen.tx;
  const chain_id = EVM_CHAIN_IDS[request.from_chain];
  if (tx.chain_id !== chain_id) {
    throw new Error(`${ID}: ${venue} returned a transaction for chain id ${tx.chain_id}, not the source chain ${request.from_chain} (${chain_id}); nothing was prepared`);
  }

  let step: "approve" | "bridge" = "bridge";
  let unsigned: UnsignedEvmTx = { kind: "evm_tx", chain: request.from_chain, chain_id, from, to: tx.to, data: tx.data, value: tx.value };
  const spender = (tx.approval_target ?? tx.to) as `0x${string}`;
  if (!native) {
    let allowance: bigint;
    try {
      allowance = await ctx.rpc(request.from_chain).readContract({
        address: request.from_token as `0x${string}`, abi: erc20Abi, functionName: "allowance", args: [from, spender],
      });
    } catch (e) {
      throw new Error(`${ID}: could not read the sender's allowance (${classifyRpcError(e).reason}); nothing was prepared`);
    }
    if (allowance < BigInt(request.from_amount)) {
      step = "approve";
      unsigned = {
        kind: "evm_tx", chain: request.from_chain, chain_id, from, to: request.from_token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, BigInt(request.from_amount)] }),
        value: "0",
      };
    }
  }

  // USD from the venue's own figure, else the source leg if it is a listed stablecoin; the
  // destination leg is on another chain and is not used. Unknown stays unknown.
  const usd = deriveUsdValue({
    venue: chosen.venue, chain: request.from_chain, sell_token: request.from_token, buy_token: "", sell_amount: request.from_amount,
    buy_amount: null, sell_usd: chosen.from_usd,
  });
  const to_address = request.to_address ?? from;
  const params: BridgePrepareParams = {
    step, lane: "cross-chain", from_chain: request.from_chain, to_chain: request.to_chain, from_token: request.from_token,
    to_token: request.to_token, from_amount: request.from_amount, from_address: from, to_address,
    slippage_bps: request.slippage_bps, venue, route_via: chosen.route_via, to_amount: chosen.to_amount,
    est_duration_s: chosen.est_duration_s, usd_value: usd.usd_value, usd_value_source: usd.source,
  };
  const feeWord = chosen.venue === "sato" ? `Sato fee ${chosen.sato_fee_bps ?? "unknown"} bps (see fee_disclosure)` : "no Sato fee";
  const summary = step === "approve"
    ? `Approve ${spender} to spend exactly ${request.from_amount} base units of ${request.from_token} on ${request.from_chain}, the first step of a bridge to ${request.to_chain} via ${venue}; prepare the bridge again after this lands.`
    : `Bridge ${request.from_amount} base units of ${request.from_token} on ${request.from_chain} to ${request.to_token} on ${request.to_chain} for ${to_address} via ${venue}${chosen.route_via ? ` (${chosen.route_via})` : ""}; quoted ${chosen.to_amount ?? "unknown"}${chosen.to_amount_min ? `, minimum ${chosen.to_amount_min}` : ""} base units on arrival; ${feeWord}. This signs on ${request.from_chain} only; arrival on ${request.to_chain} depends on the venue. USD value: ${usd.usd_value ?? "unknown"} (${usd.source}).`;

  return {
    params,
    unsigned,
    facts: {
      action: ID,
      chain: request.from_chain,
      network: ctx.policy.network,
      token: request.from_token,
      token_amount_base_units: request.from_amount,
      usd_value: usd.usd_value,
      usd_spent_today: null,
      contract: unsigned.to,
      venue,
      slippage_bps: request.slippage_bps,
    },
    summary,
    fee_disclosure: disclosureFor(chosen, directAvailable),
  };
}

export function bridgePrepareAction(): PrepareAction {
  return { descriptor: bridgePrepareDescriptor(), build: buildBridgePrepare };
}
