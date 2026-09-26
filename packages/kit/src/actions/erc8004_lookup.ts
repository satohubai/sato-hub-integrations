// ACTIONS builder. erc8004.lookup — read the ERC-8004 Identity Registry, a
// singleton ERC-721 deployed at the same address on each supported chain
// (erc-8004/erc-8004-contracts). By owner: balanceOf. By agent id: ownerOf +
// tokenURI. Read-only. "Not registered" is an answer (registered: false), not
// an error; an RPC that cannot be reached IS an error, because it answers
// nothing.
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor } from "../spec/index.js";
import type { ActionContext, ReadAction } from "../types.js";
import {
  ActionInputError, VIEM_PIN, address, addressSchema, chainSchema, classifyRpcError, evmChain, isoNow, obj,
} from "./_util.js";
import type { EvmChain } from "./_util.js";

const ID = "erc8004.lookup";
export const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
/** The ODA chains where the registry is deployed at that address (same set Sato Hub's passport checks read). */
export const ERC8004_CHAINS: EvmChain[] = ["ethereum", "base", "arbitrum", "optimism", "polygon"];

const REGISTRY_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
] as const;

export type Erc8004LookupOutput = {
  chain: EvmChain;
  registry: string;
  by: "owner" | "agent_id";
  registered: boolean;
  owner: string | null;
  agent_id: string | null;
  /** Number of agent identities the owner holds (by owner). */
  balance: string | null;
  /** The agent's registration URI as the registry returns it (by agent_id). */
  token_uri: string | null;
  as_of: string;
};

export function erc8004LookupDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Look up an ERC-8004 agent identity",
    description:
      "Reads the ERC-8004 Identity Registry. Given an owner address it returns how many agent identities that address holds; given an agent id it returns the owner and the registration URI. Read-only. An address or id with no identity returns registered false, which is an answer rather than an error. A registration shows that an identity exists on chain; it says nothing about what the agent does.",
    effects: ["read"],
    custody: { reads_key: false, sends_key: false, moves_funds: "never" },
    chains: [...ERC8004_CHAINS],
    input_schema: {
      type: "object",
      properties: {
        chain: chainSchema(ERC8004_CHAINS),
        owner: addressSchema("Look up by owner address."),
        agent_id: { type: "string", pattern: "^[0-9]{1,78}$", description: "Look up by agent id (the ERC-721 token id)." },
      },
      required: ["chain"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        chain: chainSchema(ERC8004_CHAINS),
        registry: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        by: { type: "string", enum: ["owner", "agent_id"] },
        registered: { type: "boolean" },
        owner: { description: "Owner address, or null." },
        agent_id: { description: "Agent id as a decimal string, or null." },
        balance: { description: "Identities held by the owner (decimal string), or null." },
        token_uri: { description: "Registration URI, or null." },
        as_of: { type: "string" },
      },
      required: ["chain", "registry", "by", "registered", "owner", "agent_id", "balance", "token_uri", "as_of"],
    },
    policy: { rules: [] },
    receipt: false,
    fixtures: [],
    upstream: { ...VIEM_PIN },
    sponsored: null,
  };
}

export async function erc8004Lookup(input: unknown, ctx: ActionContext): Promise<Erc8004LookupOutput> {
  const o = obj(input, ID);
  const chain = evmChain(o.chain, ERC8004_CHAINS, ID);
  const hasOwner = o.owner !== undefined && o.owner !== null;
  const hasId = o.agent_id !== undefined && o.agent_id !== null;
  if (hasOwner === hasId) throw new ActionInputError(`${ID}: give exactly one of owner or agent_id`);
  const client = ctx.rpc(chain);
  const base = { chain, registry: ERC8004_IDENTITY_REGISTRY, as_of: isoNow(ctx) };
  if (hasOwner) {
    const owner = address(o.owner, "owner", ID);
    const bal = await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: "balanceOf", args: [owner] });
    return { ...base, by: "owner", registered: bal > 0n, owner, agent_id: null, balance: bal.toString(), token_uri: null };
  }
  if (typeof o.agent_id !== "string" || !/^[0-9]{1,78}$/.test(o.agent_id)) throw new ActionInputError(`${ID}: agent_id must be a decimal string`);
  const id = BigInt(o.agent_id);
  let owner: string;
  try {
    owner = await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: "ownerOf", args: [id] });
  } catch (e) {
    // ERC-721 ownerOf reverts for a token that does not exist: that is "not registered".
    if (classifyRpcError(e).kind === "revert") {
      return { ...base, by: "agent_id", registered: false, owner: null, agent_id: o.agent_id, balance: null, token_uri: null };
    }
    throw e;
  }
  let token_uri: string | null = null;
  try {
    token_uri = await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: "tokenURI", args: [id] });
  } catch (e) {
    if (classifyRpcError(e).kind !== "revert") throw e;
  }
  return { ...base, by: "agent_id", registered: true, owner, agent_id: o.agent_id, balance: null, token_uri };
}

export function erc8004LookupAction(): ReadAction<unknown, Erc8004LookupOutput> {
  return { descriptor: erc8004LookupDescriptor(), run: erc8004Lookup };
}
