// ACTIONS builder. x402.prepare — read what an x402 resource asks to be paid
// and turn one acceptable requirement into an UnsignedX402Payment.
//
// Wire formats (github.com/coinbase/x402 specs):
//   v2 (specs/transports-v2/http.md): HTTP 402 with a PAYMENT-REQUIRED header,
//      base64 JSON { x402Version: 2, resource: { url }, accepts: [{ scheme,
//      network: "eip155:<id>", amount, asset, payTo, maxTimeoutSeconds, extra }] }.
//      The client later pays with a PAYMENT-SIGNATURE header.
//   v1: HTTP 402 with a JSON body { x402Version: 1, accepts: [{ scheme,
//      network: "base", maxAmountRequired, resource, payTo, asset, … }] }.
//
// Requirements are considered in the order the server listed them; the first
// one inside the caller's budget and the policy's allowlists is taken. When
// none fits, the build throws ActionRefusedError naming each rule.
//
// EXECUTION IS NOT PART OF THIS ACTION in M0: it prepares the payment object
// only. Signing the EIP-3009 authorization and retrying with PAYMENT-SIGNATURE
// is the signer's / a later step's job.
import { ACTION_SCHEMA_ID, allowlistPermits, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, OdaChain, Refusal, UnsignedX402Payment } from "../spec/index.js";
import type { ActionContext, PrepareAction, PrepareBuild } from "../types.js";
import { ActionInputError, ActionRefusedError, baseUnits, http, obj } from "./_util.js";

const ID = "x402.prepare";

/** x402 network ids → ODA chains. v1 used names; v2 uses CAIP-2. */
const NETWORKS: Record<string, OdaChain> = {
  base: "base",
  "base-sepolia": "base-sepolia",
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
  ethereum: "ethereum",
  "eip155:1": "ethereum",
  "eip155:11155111": "sepolia",
  sepolia: "sepolia",
  polygon: "polygon",
  "eip155:137": "polygon",
  arbitrum: "arbitrum",
  "eip155:42161": "arbitrum",
  optimism: "optimism",
  "eip155:10": "optimism",
  solana: "solana",
  "solana-devnet": "solana-devnet",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "solana-devnet",
};

/** USDC, whose base units are 10^-6 USD. Only these get a usd_value; any other asset is null (unknown price). */
const USDC: Record<string, true> = {
  "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": true,
  "base-sepolia:0x036cbd53842c5426634e7929541ec2318f3dcf7e": true,
  "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": true,
  "polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": true,
  "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831": true,
  "optimism:0x0b2c639c533813f4aa9d7837caf62653d097ff85": true,
};

export type X402Requirement = {
  x402_version: 1 | 2;
  scheme: string;
  network: string;
  chain: OdaChain | null;
  amount: string;
  asset: string;
  pay_to: string;
  resource: string;
};

export const X402_PREPARE_FIXTURES = ["test/fixtures/x402-v2-payment-required.json", "test/fixtures/x402-v1-body.json"];

export function x402PrepareDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Prepare an x402 payment",
    description:
      "Fetches a resource that answers with HTTP 402, reads its x402 payment requirements (the PAYMENT-REQUIRED header, or the JSON body used by the earlier version), and prepares an unsigned payment for the first requirement that fits your budget and the policy allowlists. If none fits it refuses and names each rule. It returns an intent to review; no payment happens until execute hands it to your signer, which is where limits are enforced.",
    effects: ["sign", "pay"],
    custody: { reads_key: false, sends_key: false, moves_funds: "with_approval" },
    chains: ["base", "base-sepolia", "ethereum", "sepolia", "polygon", "arbitrum", "optimism", "solana", "solana-devnet"],
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", pattern: "^https?://", description: "The x402 resource." },
        max_amount_base_units: { type: "string", pattern: "^[0-9]{1,78}$", description: "The most you will pay, in the asset's base units." },
        asset: { type: "string", description: "Only accept requirements in this asset (address or mint)." },
        network: { type: "string", description: "Only accept requirements on this x402 network id, e.g. base or eip155:8453." },
      },
      required: ["url", "max_amount_base_units"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      description: "A PreparedIntent whose unsigned payload is an x402_payment.",
      properties: {
        intent_id: { type: "string", pattern: "^si_[A-Za-z0-9_-]{43}$" },
        action: { type: "string" },
        expires_at: { type: "string" },
        summary: { type: "string" },
        policy: { type: "object" },
        simulation: { description: "Null: an x402 payment is not an EVM transaction." },
        fee_disclosure: { description: "Null: no Sato fee is involved." },
        unsigned: { type: "object", description: "UnsignedX402Payment." },
      },
      required: ["intent_id", "action", "expires_at", "summary", "policy", "unsigned"],
    },
    policy: {
      rules: ["network_mainnet_not_enabled", "chain_allowlist", "token_allowlist", "recipient_allowlist", "max_per_trade", "max_usd_per_trade", "max_usd_per_day", "unknown_price", "intent_ttl"],
    },
    receipt: true,
    fixtures: [...X402_PREPARE_FIXTURES],
    upstream: {},
    sponsored: null,
  };
}

function decodeBase64Json(v: string): unknown {
  const bin = atob(v.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Parse the requirements out of a 402 response. v2 header first, then the v1 body. */
export function parseX402Requirements(headers: Headers, body: unknown, url: string): X402Requirement[] {
  const header = headers.get("payment-required");
  let doc: Record<string, unknown> | null = null;
  let version: 1 | 2 = 1;
  if (header) {
    try {
      doc = decodeBase64Json(header) as Record<string, unknown>;
      version = 2;
    } catch {
      doc = null;
    }
  }
  if (!doc && body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).accepts)) {
    doc = body as Record<string, unknown>;
    version = (doc.x402Version === 2 ? 2 : 1) as 1 | 2;
  }
  if (!doc || !Array.isArray(doc.accepts)) return [];
  const topResource = (doc.resource as { url?: unknown } | undefined)?.url;
  const out: X402Requirement[] = [];
  for (const a of doc.accepts as Array<Record<string, unknown>>) {
    const amount = version === 2 ? a.amount : a.maxAmountRequired ?? a.amount;
    if (typeof a.network !== "string" || typeof a.payTo !== "string" || typeof a.asset !== "string") continue;
    if (typeof amount !== "string" || !/^[0-9]{1,78}$/.test(amount)) continue;
    out.push({
      x402_version: version,
      scheme: typeof a.scheme === "string" ? a.scheme : "unknown",
      network: a.network,
      chain: NETWORKS[a.network] ?? null,
      amount,
      asset: a.asset,
      pay_to: a.payTo,
      resource: typeof a.resource === "string" ? a.resource : typeof topResource === "string" ? topResource : url,
    });
  }
  return out;
}

/** The refusals one requirement meets under the budget and policy; empty = it fits. */
function refusalsFor(req: X402Requirement, max: bigint, asset: string | null, network: string | null, ctx: ActionContext): Refusal[] {
  const r: Refusal[] = [];
  const p = ctx.policy;
  if (req.scheme !== "exact") {
    r.push({ rule: "unknown_verdict", limit: "exact", observed: req.scheme, message: `scheme ${req.scheme} is not supported; only exact` });
  }
  if (!req.chain) {
    r.push({ rule: "chain_allowlist", limit: "a known x402 network", observed: req.network, message: `network ${req.network} is not one this kit knows` });
  } else if (!allowlistPermits(p.allow_chains, req.chain)) {
    r.push({ rule: "chain_allowlist", limit: p.allow_chains.join(",") || "any", observed: req.chain, message: `chain ${req.chain} is not in allow_chains` });
  }
  if (network && network.toLowerCase() !== req.network.toLowerCase()) {
    r.push({ rule: "chain_allowlist", limit: network, observed: req.network, message: `the caller asked for network ${network}` });
  }
  if (asset && asset.toLowerCase() !== req.asset.toLowerCase()) {
    r.push({ rule: "token_allowlist", limit: asset, observed: req.asset, message: `the caller asked for asset ${asset}` });
  }
  if (req.chain && !allowlistPermits(p.allow_tokens, `${req.chain}:${req.asset}`)) {
    r.push({ rule: "token_allowlist", limit: p.allow_tokens.join(",") || "any", observed: `${req.chain}:${req.asset}`, message: "asset is not in allow_tokens" });
  }
  if (req.chain && !allowlistPermits(p.allow_recipients, `${req.chain}:${req.pay_to}`)) {
    r.push({ rule: "recipient_allowlist", limit: p.allow_recipients.join(",") || "any", observed: `${req.chain}:${req.pay_to}`, message: "payTo is not in allow_recipients" });
  }
  if (BigInt(req.amount) > max) {
    r.push({ rule: "max_per_trade", limit: max.toString(), observed: req.amount, message: `asks ${req.amount} base units; the caller's budget is ${max}` });
  }
  return r;
}

export async function buildX402Prepare(input: unknown, ctx: ActionContext): Promise<PrepareBuild> {
  const o = obj(input, ID);
  if (typeof o.url !== "string" || !/^https?:\/\//.test(o.url)) throw new ActionInputError(`${ID}: url must be an http(s) URL`);
  const url = o.url;
  const max = BigInt(baseUnits(o.max_amount_base_units, "max_amount_base_units", ID));
  const asset = typeof o.asset === "string" && o.asset ? o.asset : null;
  const network = typeof o.network === "string" && o.network ? o.network : null;

  const res = await http(ctx, url);
  if (res.status !== 402) throw new Error(`${ID}: ${url} answered HTTP ${res.status}, not 402 — no payment is required`);
  const reqs = parseX402Requirements(res.headers, res.body, url);
  if (reqs.length === 0) throw new Error(`${ID}: ${url} answered 402 but carried no readable x402 requirements`);

  const all: Refusal[] = [];
  for (const req of reqs) {
    const refusals = refusalsFor(req, max, asset, network, ctx);
    if (refusals.length) {
      all.push(...refusals.map((x) => ({ ...x, message: `${req.network}/${req.asset}: ${x.message}` })));
      continue;
    }
    const chain = req.chain as OdaChain;
    const unsigned: UnsignedX402Payment = { kind: "x402_payment", network: req.network, resource: req.resource, pay_to: req.pay_to, asset: req.asset, amount: req.amount };
    const usd = USDC[`${chain}:${req.asset.toLowerCase()}`] ? Number(req.amount) / 1e6 : null;
    return {
      params: { url, x402_version: req.x402_version, scheme: req.scheme, network: req.network, asset: req.asset, pay_to: req.pay_to, amount: req.amount, max_amount_base_units: max.toString() },
      unsigned,
      facts: {
        action: ID, chain, network: ctx.policy.network, token: req.asset, token_amount_base_units: req.amount,
        usd_value: usd, usd_spent_today: null, contract: req.asset, recipient: req.pay_to,
      },
      summary: `Pay ${req.amount} base units of ${req.asset} on ${req.network} to ${req.pay_to} for ${req.resource} (x402 v${req.x402_version}, scheme ${req.scheme}).`,
      fee_disclosure: null,
    };
  }
  throw new ActionRefusedError(`${ID}: none of the ${reqs.length} payment requirement(s) fit the budget and policy`, all);
}

export function x402PrepareAction(): PrepareAction {
  return { descriptor: x402PrepareDescriptor(), build: buildX402Prepare };
}
