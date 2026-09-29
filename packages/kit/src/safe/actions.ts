// ACTIONS builder. safe.info (read) and safe.propose (prepare).
//
// A thin wrapper over the official Safe Transaction Service (keyless GET):
//   GET https://api.safe.global/tx-service/<shortName>/api/v1/safes/<address>/
// (the per-chain safe-transaction-<network>.safe.global hosts now answer 308
// to these URLs). It returns the Safe's nonce, threshold, owners and version.
//
// safe.propose builds the SafeTx EIP-712 typed data for ONE inner call and
// returns it as a typed_data unsigned payload with submit = safe_tx_service.
// execute has the signer sign it and POSTs the signature to the service as a
// proposal; nothing moves on chain until the Safe's owners reach the threshold
// and execute. The pre-flight facts come from the INNER call (its contract,
// recipient and value), so allowlists and caps apply to what the Safe would do.
// Only operation 0 (CALL) is built: a DELEGATECALL runs foreign code as the
// Safe itself, which no allowlist here can describe.
import { getAddress } from "viem";
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, UnsignedEvmTx, UnsignedTypedData } from "../spec/index.js";
import type { ActionContext, PrepareAction, PrepareBuild, ReadAction } from "../types.js";
import {
  ActionInputError, EVM_CHAIN_IDS, VIEM_PIN, address, addressSchema, baseUnits, baseUnitsSchema, chainSchema, evmChain, hex, http, isoNow, obj,
} from "../actions/_util.js";
import type { EvmChain } from "../actions/_util.js";

const INFO_ID = "safe.info";
const PROPOSE_ID = "safe.propose";
export const SAFE_FIXTURES = ["test/fixtures/safe-info.base-sepolia.json"];

/** Chain -> Safe Transaction Service short name, each checked against /api/v1/about/. */
export const SAFE_TX_SERVICE_SHORT_NAMES = {
  ethereum: "eth",
  sepolia: "sep",
  base: "base",
  "base-sepolia": "basesep",
  arbitrum: "arb1",
  optimism: "oeth",
  polygon: "pol",
} as const satisfies Partial<Record<EvmChain, string>>;
export type SafeChain = keyof typeof SAFE_TX_SERVICE_SHORT_NAMES;
export const SAFE_CHAINS = Object.keys(SAFE_TX_SERVICE_SHORT_NAMES) as SafeChain[];

/** Native asset symbol per chain, used as the token fact when the inner call sends value. */
const NATIVE: Record<SafeChain, string> = {
  ethereum: "ETH", sepolia: "ETH", base: "ETH", "base-sepolia": "ETH", arbitrum: "ETH", optimism: "ETH", polygon: "POL",
};

export const SAFE_TX_SERVICE_BASE = "https://api.safe.global/tx-service";
export function safeTxServiceUrl(chain: SafeChain): string {
  return `${SAFE_TX_SERVICE_BASE}/${SAFE_TX_SERVICE_SHORT_NAMES[chain]}`;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The SafeTx EIP-712 struct (Safe contracts v1.1.0 and later). */
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

export type SafeInfo = {
  chain: SafeChain;
  safe_address: string;
  nonce: string;
  threshold: number;
  owners: string[];
  version: string | null;
  modules: string[];
  guard: string | null;
  service_url: string;
  as_of: string;
};

const chainIn = (description = "Chain the Safe is deployed on.") => chainSchema(SAFE_CHAINS, description);

const infoOutputProps = {
  chain: chainIn(),
  safe_address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
  nonce: { type: "string", pattern: "^[0-9]{1,78}$", description: "The Safe's current on-chain nonce." },
  threshold: { type: "integer" },
  owners: { type: "array", items: { type: "string" } },
  version: { description: "Safe contract version as the service reports it, or null when unknown." },
  modules: { type: "array", items: { type: "string" } },
  guard: { description: "Guard address, or null when none is set." },
  service_url: { type: "string" },
  as_of: { type: "string" },
};

export function safeInfoDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: INFO_ID,
    name: odaIdToToolName(INFO_ID),
    version: "0.1.0",
    title: "Read a Safe's owners, threshold and nonce",
    description:
      "Reads a multisig smart account (the SafeTx contract family) from its official transaction service: owners, signature threshold, current nonce, contract version, enabled modules and guard. Read-only and keyless.",
    effects: ["read"],
    custody: { reads_key: false, sends_key: false, moves_funds: "never" },
    chains: [...SAFE_CHAINS],
    input_schema: {
      type: "object",
      properties: { chain: chainIn(), safe_address: addressSchema("The Safe's address.") },
      required: ["chain", "safe_address"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: infoOutputProps,
      required: ["chain", "safe_address", "nonce", "threshold", "owners", "version", "modules", "guard", "service_url", "as_of"],
    },
    policy: { rules: [] },
    receipt: false,
    fixtures: [...SAFE_FIXTURES],
    upstream: { ...VIEM_PIN },
    sponsored: null,
  };
}

/** One GET to the service. Exported for safe.propose and tests. */
export async function readSafe(ctx: ActionContext, chain: SafeChain, safe: `0x${string}`, action = INFO_ID): Promise<SafeInfo> {
  const service = safeTxServiceUrl(chain);
  const url = `${service}/api/v1/safes/${getAddress(safe)}/`;
  const r = await http(ctx, url);
  if (r.status === 404) throw new ActionInputError(`${action}: the Safe Transaction Service has no Safe at ${safe} on ${chain}`);
  if (r.status < 200 || r.status >= 300) throw new Error(`${action}: Safe Transaction Service answered HTTP ${r.status}${r.text ? `: ${r.text.slice(0, 200)}` : ""}`);
  const b = r.body as Record<string, unknown> | null;
  if (!b || typeof b.nonce === "undefined" || typeof b.threshold !== "number" || !Array.isArray(b.owners)) {
    throw new Error(`${action}: Safe Transaction Service answer is missing nonce, threshold or owners`);
  }
  const nonce = String(b.nonce);
  if (!/^[0-9]{1,78}$/.test(nonce)) throw new Error(`${action}: Safe Transaction Service returned a non-numeric nonce`);
  const guard = typeof b.guard === "string" && b.guard.toLowerCase() !== ZERO_ADDRESS ? getAddress(b.guard) : null;
  return {
    chain,
    safe_address: getAddress(safe),
    nonce,
    threshold: b.threshold,
    owners: (b.owners as unknown[]).map((o) => getAddress(String(o))),
    version: typeof b.version === "string" ? b.version : null,
    modules: Array.isArray(b.modules) ? (b.modules as unknown[]).map((m) => getAddress(String(m))) : [],
    guard,
    service_url: service,
    as_of: isoNow(ctx),
  };
}

export async function safeInfo(input: unknown, ctx: ActionContext): Promise<SafeInfo> {
  const o = obj(input, INFO_ID);
  const chain = evmChain(o.chain, SAFE_CHAINS, INFO_ID) as SafeChain;
  const safe = address(o.safe_address, "safe_address", INFO_ID);
  return readSafe(ctx, chain, safe);
}

export function safeInfoAction(): ReadAction<unknown, SafeInfo> {
  return { descriptor: safeInfoDescriptor(), run: safeInfo };
}

// ── safe.propose ─────────────────────────────────────────────────────────────

/** "1.3.0+L2" -> [1,3,0]; null when unparseable. */
function parseVersion(v: string | null): [number, number, number] | null {
  const m = v ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** EIP-712 domain: chainId joined the Safe domain in v1.3.0; earlier versions sign with verifyingContract only. */
export function safeDomain(version: string | null, chainId: number, safe: string): Record<string, unknown> {
  const v = parseVersion(version);
  if (!v) throw new ActionInputError(`${PROPOSE_ID}: the Safe's contract version is unknown, so its signing domain cannot be built`);
  if (v[0] < 1 || (v[0] === 1 && v[1] < 1)) throw new ActionInputError(`${PROPOSE_ID}: Safe version ${version} predates the SafeTx struct this action builds (1.1.0 and later)`);
  return v[0] > 1 || v[1] >= 3 ? { chainId, verifyingContract: safe } : { verifyingContract: safe };
}

export type SafeProposeParams = {
  chain: SafeChain;
  safe_address: string;
  signer: string;
  to: string;
  value: string;
  data: string;
  nonce: string;
  threshold: number;
};

type InnerCall = { to: `0x${string}`; value: string; data: `0x${string}` };

function innerCall(o: Record<string, unknown>, chain: SafeChain, safe: string): InnerCall {
  const hasCall = o.call !== undefined && o.call !== null;
  const hasTx = o.inner_tx !== undefined && o.inner_tx !== null;
  if (hasCall === hasTx) throw new ActionInputError(`${PROPOSE_ID}: pass exactly one of call or inner_tx`);
  if (hasTx) {
    const t = obj(o.inner_tx, `${PROPOSE_ID}.inner_tx`) as Partial<UnsignedEvmTx>;
    if (t.kind !== "evm_tx") throw new ActionInputError(`${PROPOSE_ID}: inner_tx must be an evm_tx unsigned payload`);
    if (t.chain !== chain || t.chain_id !== EVM_CHAIN_IDS[chain]) throw new ActionInputError(`${PROPOSE_ID}: inner_tx is for ${String(t.chain)}, not ${chain}`);
    if (typeof t.from === "string" && getAddress(t.from) !== getAddress(safe)) {
      throw new ActionInputError(`${PROPOSE_ID}: inner_tx was prepared from ${t.from}, not from the Safe ${safe}; prepare it with the Safe as the sender`);
    }
    return { to: address(t.to, "inner_tx.to", PROPOSE_ID), value: baseUnits(t.value ?? "0", "inner_tx.value", PROPOSE_ID), data: hex(t.data ?? "0x", "inner_tx.data", PROPOSE_ID) };
  }
  const c = obj(o.call, `${PROPOSE_ID}.call`);
  return {
    to: address(c.to, "call.to", PROPOSE_ID),
    value: c.value === undefined ? "0" : baseUnits(c.value, "call.value", PROPOSE_ID),
    data: c.data === undefined ? "0x" : hex(c.data, "call.data", PROPOSE_ID),
  };
}

export function safeProposeDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: PROPOSE_ID,
    name: odaIdToToolName(PROPOSE_ID),
    version: "0.1.0",
    title: "Prepare a Safe transaction proposal",
    description:
      "Builds the SafeTx typed data for one call from a multisig smart account, using the nonce and owners read from its official transaction service. The policy pre-flight checks the inner call's contract, recipient and value. It refuses when the signer is not an owner. execute has your signer sign it and posts the signature to that service as a proposal; nothing moves until the owners reach the threshold and execute it.",
    effects: ["sign"],
    custody: { reads_key: false, sends_key: false, moves_funds: "with_approval" },
    chains: [...SAFE_CHAINS],
    input_schema: {
      type: "object",
      properties: {
        chain: chainIn(),
        safe_address: addressSchema("The Safe's address."),
        signer: addressSchema("The owner who signs the proposal. Defaults to the configured signer's address."),
        call: {
          type: "object",
          description: "The call the Safe would make. Pass this or inner_tx.",
          properties: {
            to: addressSchema("Target contract or recipient."),
            value: baseUnitsSchema("Native value in wei. Default 0."),
            data: { type: "string", pattern: "^0x[0-9a-fA-F]*$", description: "Calldata. Default 0x." },
          },
          required: ["to"],
          additionalProperties: false,
        },
        inner_tx: {
          type: "object",
          description: "An evm_tx unsigned payload another prepare returned, prepared with the Safe as sender. Its to, value and data become the Safe call.",
          properties: {
            kind: { type: "string", enum: ["evm_tx"] },
            chain: chainIn("Must equal chain."),
            chain_id: { type: "integer", enum: SAFE_CHAINS.map((c) => EVM_CHAIN_IDS[c]), description: "Chain id; must match chain." },
            from: addressSchema("The Safe's address."),
            to: addressSchema("Target."),
            data: { type: "string", pattern: "^0x[0-9a-fA-F]*$" },
            value: baseUnitsSchema("Native value in wei."),
          },
          required: ["kind", "chain", "chain_id", "to", "data", "value"],
        },
        nonce: baseUnitsSchema("Override the Safe nonce, e.g. to queue after pending proposals. Default: the Safe's current nonce."),
      },
      required: ["chain", "safe_address"],
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
        simulation: { description: "Always null: signing a proposal has no on-chain effect; the summary says why." },
        fee_disclosure: { description: "Always null: no venue is involved." },
        unsigned: { type: "object", description: "UnsignedTypedData (SafeTx) with submit safe_tx_service." },
      },
      required: ["intent_id", "action", "expires_at", "summary", "policy", "simulation", "fee_disclosure", "unsigned"],
    },
    policy: {
      rules: ["network_mainnet_not_enabled", "chain_allowlist", "token_allowlist", "contract_allowlist", "recipient_allowlist", "max_per_trade", "max_usd_per_trade", "max_usd_per_day", "unknown_price", "intent_ttl"],
    },
    receipt: true,
    fixtures: [...SAFE_FIXTURES],
    upstream: { ...VIEM_PIN },
    sponsored: null,
  };
}

export async function buildSafePropose(input: unknown, ctx: ActionContext): Promise<PrepareBuild> {
  const o = obj(input, PROPOSE_ID);
  const chain = evmChain(o.chain, SAFE_CHAINS, PROPOSE_ID) as SafeChain;
  const safe = getAddress(address(o.safe_address, "safe_address", PROPOSE_ID));
  const call = innerCall(o, chain, safe);
  let signer: `0x${string}`;
  if (o.signer !== undefined && o.signer !== null) signer = getAddress(address(o.signer, "signer", PROPOSE_ID));
  else if (ctx.signer) signer = getAddress(await ctx.signer.address(chain));
  else throw new ActionInputError(`${PROPOSE_ID}: no signer configured; pass signer (an owner's address)`);

  const info = await readSafe(ctx, chain, safe, PROPOSE_ID);
  if (!info.owners.includes(signer)) {
    throw new ActionInputError(`${PROPOSE_ID}: ${signer} is not an owner of Safe ${safe} on ${chain} (owners: ${info.owners.join(", ")}); refusing to build a proposal it cannot sign`);
  }
  const nonce = o.nonce === undefined || o.nonce === null ? info.nonce : baseUnits(o.nonce, "nonce", PROPOSE_ID);
  if (BigInt(nonce) < BigInt(info.nonce)) throw new ActionInputError(`${PROPOSE_ID}: nonce ${nonce} is below the Safe's current nonce ${info.nonce}, so it can never execute`);
  const chainId = EVM_CHAIN_IDS[chain];

  const unsigned: UnsignedTypedData = {
    kind: "typed_data",
    chain,
    chain_id: chainId,
    signer,
    domain: safeDomain(info.version, chainId, safe),
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx",
    message: {
      to: getAddress(call.to), value: call.value, data: call.data, operation: 0,
      safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS, nonce,
    },
    submit: { kind: "safe_tx_service", url: info.service_url, safe_address: safe },
  };

  const sendsValue = call.value !== "0";
  const hasData = call.data !== "0x";
  const params: SafeProposeParams = { chain, safe_address: safe, signer, to: getAddress(call.to), value: call.value, data: call.data, nonce, threshold: info.threshold };
  const what = hasData ? `call ${getAddress(call.to)} with ${(call.data.length - 2) / 2} bytes of calldata` : `send to ${getAddress(call.to)}`;
  const valueTxt = sendsValue ? `, value ${call.value} wei of ${NATIVE[chain]}` : ", no native value";
  return {
    params,
    unsigned,
    facts: {
      action: PROPOSE_ID,
      chain,
      network: ctx.policy.network,
      ...(sendsValue ? { token: NATIVE[chain], token_amount_base_units: call.value } : {}),
      // A native amount is priced by no source here: stated as unknown, never guessed. A zero-value call moves no native funds.
      usd_value: sendsValue ? null : 0,
      usd_spent_today: null,
      ...(hasData ? { contract: getAddress(call.to) } : {}),
      ...(!hasData || sendsValue ? { recipient: getAddress(call.to) } : {}),
    },
    summary: `Propose from Safe ${safe} (${chain}, nonce ${nonce}): ${what}${valueTxt}. ${signer} signs as one of ${info.owners.length} owners; ${info.threshold} signature(s) are needed before any owner can execute it.`,
    fee_disclosure: null,
  };
}

export function safeProposeAction(): PrepareAction {
  return { descriptor: safeProposeDescriptor(), build: buildSafePropose };
}
