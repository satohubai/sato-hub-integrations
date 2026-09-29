// ACTIONS builder. token.approvals.list / token.approvals.revoke.
//
// list reads, for ONE token and the spenders the caller names, what the owner
// has granted: ERC-20 allowance(owner, spender), or ERC-721/1155
// isApprovedForAll(owner, operator). No log scanning, so it never claims to
// know spenders it was not asked about.
//
// revoke is a prepare: ERC-20 approve(spender, 0), or ERC-721/1155
// setApprovalForAll(operator, false). It returns an unsigned evm_tx the kit
// simulates, runs through the pre-flight and hands to execute(intent_id).
// A revoke transfers no tokens; its pre-flight facts name the token (as
// contract) and the spender.
import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, UnsignedEvmTx } from "../spec/index.js";
import type { ActionContext, PrepareAction, PrepareBuild, ReadAction } from "../types.js";
import {
  ActionInputError, EVM_CHAINS, EVM_CHAIN_IDS, VIEM_PIN, address, addressSchema, chainSchema, evmChain, isoNow, obj,
} from "./_util.js";
import type { EvmChain } from "./_util.js";

const LIST_ID = "token.approvals.list";
const REVOKE_ID = "token.approvals.revoke";
export const APPROVAL_KINDS = ["erc20", "erc721", "erc1155"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export const MAX_SPENDERS = 25;
export const TOKEN_REVOKE_FIXTURES = ["test/fixtures/token-revoke.base.json"];

/** setApprovalForAll / isApprovedForAll share this signature on ERC-721 and ERC-1155. */
const OPERATOR_ABI = [
  { type: "function", name: "isApprovedForAll", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "setApprovalForAll", stateMutability: "nonpayable", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] },
] as const;

const kindSchema = { type: "string", enum: [...APPROVAL_KINDS], description: "Token standard. erc20 reads allowance; erc721 and erc1155 read operator approval for all. Default erc20." };

function kindOf(v: unknown, id: string): ApprovalKind {
  if (v === undefined || v === null) return "erc20";
  if (typeof v !== "string" || !(APPROVAL_KINDS as readonly string[]).includes(v)) throw new ActionInputError(`${id}: kind must be one of ${APPROVAL_KINDS.join(", ")}`);
  return v as ApprovalKind;
}

export type ApprovalRow = {
  spender: string;
  /** ERC-20: allowance in base units (decimal string); null for erc721/erc1155. */
  allowance: string | null;
  /** ERC-20: true when the allowance equals 2^256-1; null for erc721/erc1155. */
  is_max_uint256: boolean | null;
  /** erc721/erc1155: isApprovedForAll; null for erc20. */
  approved_for_all: boolean | null;
};

export type TokenApprovalsListOutput = {
  chain: EvmChain;
  owner: string;
  token: string;
  kind: ApprovalKind;
  approvals: ApprovalRow[];
  /** What this read covers, stated so an empty-looking answer is not read as "no approvals anywhere". */
  coverage: string;
  as_of: string;
};

export function tokenApprovalsListDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: LIST_ID,
    name: odaIdToToolName(LIST_ID),
    version: "0.1.0",
    title: "Read token approvals for named spenders",
    description:
      "Reads what an owner has granted on one token to each spender you name: the ERC-20 allowance, or the ERC-721/ERC-1155 operator approval for all. Read-only. It does not scan logs, so it reports only the spenders you pass and says nothing about any others.",
    effects: ["read"],
    custody: { reads_key: false, sends_key: false, moves_funds: "never" },
    chains: [...EVM_CHAINS],
    input_schema: {
      type: "object",
      properties: {
        chain: chainSchema(EVM_CHAINS),
        owner: addressSchema("The address that granted the approvals."),
        token: addressSchema("The token contract."),
        kind: kindSchema,
        spenders: { type: "array", items: addressSchema("A spender or operator address."), minItems: 1, maxItems: MAX_SPENDERS, description: "Spenders or operators to read." },
      },
      required: ["chain", "owner", "token", "spenders"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        chain: chainSchema(EVM_CHAINS),
        owner: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        token: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        kind: { type: "string", enum: [...APPROVAL_KINDS] },
        approvals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              spender: { type: "string" },
              allowance: { description: "ERC-20 allowance in base units, or null." },
              is_max_uint256: { description: "ERC-20: allowance equals 2^256-1, or null." },
              approved_for_all: { description: "ERC-721/1155 operator approval, or null." },
            },
            required: ["spender", "allowance", "is_max_uint256", "approved_for_all"],
          },
        },
        coverage: { type: "string" },
        as_of: { type: "string" },
      },
      required: ["chain", "owner", "token", "kind", "approvals", "coverage", "as_of"],
    },
    policy: { rules: [] },
    receipt: false,
    fixtures: [...TOKEN_REVOKE_FIXTURES],
    upstream: { ...VIEM_PIN },
    sponsored: null,
  };
}

export async function tokenApprovalsList(input: unknown, ctx: ActionContext): Promise<TokenApprovalsListOutput> {
  const o = obj(input, LIST_ID);
  const chain = evmChain(o.chain, EVM_CHAINS, LIST_ID);
  const owner = address(o.owner, "owner", LIST_ID);
  const token = address(o.token, "token", LIST_ID);
  const kind = kindOf(o.kind, LIST_ID);
  if (!Array.isArray(o.spenders) || o.spenders.length === 0 || o.spenders.length > MAX_SPENDERS) {
    throw new ActionInputError(`${LIST_ID}: spenders must be a list of 1..${MAX_SPENDERS} addresses`);
  }
  const spenders = o.spenders.map((s, i) => address(s, `spenders[${i}]`, LIST_ID));
  const client = ctx.rpc(chain);
  const approvals: ApprovalRow[] = [];
  for (const spender of spenders) {
    if (kind === "erc20") {
      const a = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
      approvals.push({ spender, allowance: a.toString(), is_max_uint256: a === maxUint256, approved_for_all: null });
    } else {
      const b = await client.readContract({ address: token, abi: OPERATOR_ABI, functionName: "isApprovedForAll", args: [owner, spender] });
      approvals.push({ spender, allowance: null, is_max_uint256: null, approved_for_all: b });
    }
  }
  return {
    chain, owner, token, kind, approvals,
    coverage: `Only the ${spenders.length} spender(s) passed in were read; approvals to any other address were not looked for.`,
    as_of: isoNow(ctx),
  };
}

export function tokenApprovalsListAction(): ReadAction<unknown, TokenApprovalsListOutput> {
  return { descriptor: tokenApprovalsListDescriptor(), run: tokenApprovalsList };
}

export type TokenRevokeParams = { chain: EvmChain; owner: string; token: string; spender: string; kind: ApprovalKind; current: string | null };

export function tokenApprovalsRevokeDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: REVOKE_ID,
    name: odaIdToToolName(REVOKE_ID),
    version: "0.1.0",
    title: "Prepare an approval revoke",
    description:
      "Builds the unsigned transaction that withdraws one approval: ERC-20 approve(spender, 0), or ERC-721/ERC-1155 setApprovalForAll(operator, false). It transfers no tokens. It returns an intent to review and runs the policy pre-flight, naming the token and the spender; nothing is sent until execute hands it to your signer.",
    effects: ["sign", "broadcast"],
    custody: { reads_key: false, sends_key: false, moves_funds: "with_approval" },
    chains: [...EVM_CHAINS],
    input_schema: {
      type: "object",
      properties: {
        chain: chainSchema(EVM_CHAINS),
        owner: addressSchema("The address that granted the approval; it signs the revoke."),
        token: addressSchema("The token contract."),
        spender: addressSchema("The spender or operator to revoke."),
        kind: kindSchema,
      },
      required: ["chain", "owner", "token", "spender"],
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
        fee_disclosure: { description: "Always null: no venue is involved." },
        unsigned: { type: "object", description: "UnsignedEvmTx calling the token contract." },
      },
      required: ["intent_id", "action", "expires_at", "summary", "policy", "simulation", "fee_disclosure", "unsigned"],
    },
    policy: {
      rules: ["network_mainnet_not_enabled", "chain_allowlist", "token_allowlist", "contract_allowlist", "intent_ttl", "simulation_required", "simulation_failed"],
    },
    receipt: true,
    fixtures: [...TOKEN_REVOKE_FIXTURES],
    upstream: { ...VIEM_PIN },
    sponsored: null,
  };
}

export async function buildTokenRevoke(input: unknown, ctx: ActionContext): Promise<PrepareBuild> {
  const o = obj(input, REVOKE_ID);
  const chain = evmChain(o.chain, EVM_CHAINS, REVOKE_ID);
  const owner = address(o.owner, "owner", REVOKE_ID);
  const token = address(o.token, "token", REVOKE_ID);
  const spender = address(o.spender, "spender", REVOKE_ID);
  const kind = kindOf(o.kind, REVOKE_ID);

  // The current approval, read so the summary can say what the revoke changes. A read failure is stated, not guessed.
  let current: string | null = null;
  try {
    const client = ctx.rpc(chain);
    current = kind === "erc20"
      ? (await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] })).toString()
      : String(await client.readContract({ address: token, abi: OPERATOR_ABI, functionName: "isApprovedForAll", args: [owner, spender] }));
  } catch {
    // Unreadable (RPC down, or not that token standard): stated as unknown; the simulation decides whether the call works.
    current = null;
  }

  const data = kind === "erc20"
    ? encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 0n] })
    : encodeFunctionData({ abi: OPERATOR_ABI, functionName: "setApprovalForAll", args: [spender, false] });
  const unsigned: UnsignedEvmTx = { kind: "evm_tx", chain, chain_id: EVM_CHAIN_IDS[chain], from: owner, to: token, data, value: "0" };
  const what = kind === "erc20" ? `approve(${spender}, 0)` : `setApprovalForAll(${spender}, false)`;
  const now = current === null ? "could not be read" : kind === "erc20" ? `${current} base units` : `approved_for_all ${current}`;
  const params: TokenRevokeParams = { chain, owner, token, spender, kind, current };
  return {
    params,
    unsigned,
    facts: {
      action: REVOKE_ID,
      chain,
      network: ctx.policy.network,
      token,
      token_amount_base_units: "0",
      // A revoke moves no tokens: the value transferred is zero (gas is not counted here, as for every action).
      usd_value: 0,
      usd_spent_today: null,
      contract: token,
      spender,
    },
    summary: `Revoke ${kind} approval on ${token} (${chain}) for ${spender} by calling ${what} from ${owner}. Current approval: ${now}. No tokens are transferred.`,
    fee_disclosure: null,
  };
}

export function tokenApprovalsRevokeAction(): PrepareAction {
  return { descriptor: tokenApprovalsRevokeDescriptor(), build: buildTokenRevoke };
}
