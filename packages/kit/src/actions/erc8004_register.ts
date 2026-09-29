// ACTIONS builder. erc8004.register — prepare the ERC-8004 Identity Registry's
// register(string agentURI) call, the same singleton erc8004.lookup reads
// (0x8004A169…A432; Sato Hub's passport checks read it at that address). The
// function and its return were confirmed against the deployed implementation
// on Base by eth_call at a pinned block (test/fixtures/erc8004-register.base.json).
// Chains without the registry at that address are refused, never guessed.
// The output is an unsigned evm_tx: simulate, pre-flight, execute(intent_id).
import { encodeFunctionData } from "viem";
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, UnsignedEvmTx } from "../spec/index.js";
import type { ActionContext, PrepareAction, PrepareBuild } from "../types.js";
import { ActionInputError, EVM_CHAIN_IDS, VIEM_PIN, address, addressSchema, chainSchema, obj } from "./_util.js";
import type { EvmChain } from "./_util.js";
import { ERC8004_CHAINS, ERC8004_IDENTITY_REGISTRY } from "./erc8004_lookup.js";

const ID = "erc8004.register";
export const ERC8004_REGISTER_FIXTURES = ["test/fixtures/erc8004-register.base.json"];
export const AGENT_URI_MAX = 2048;

export const ERC8004_REGISTER_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
] as const;

export type Erc8004RegisterParams = { chain: EvmChain; owner: string; registry: string; agent_uri: string };

export function erc8004RegisterDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Prepare an ERC-8004 agent registration",
    description:
      "Builds the unsigned transaction that calls register(agentURI) on the ERC-8004 Identity Registry, minting an agent identity to the signing address. Chains without the registry deployed are refused. It returns an intent to review and runs the policy pre-flight; nothing is sent until execute hands it to your signer. A registration records that an identity exists; it says nothing about what the agent does.",
    effects: ["sign", "broadcast"],
    custody: { reads_key: false, sends_key: false, moves_funds: "with_approval" },
    chains: [...ERC8004_CHAINS],
    input_schema: {
      type: "object",
      properties: {
        chain: chainSchema(ERC8004_CHAINS),
        owner: addressSchema("The address that signs and receives the identity."),
        agent_uri: { type: "string", minLength: 1, maxLength: AGENT_URI_MAX, description: "The agent registration URI (for example https:// or ipfs://) the registry stores." },
      },
      required: ["chain", "owner", "agent_uri"],
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
        unsigned: { type: "object", description: "UnsignedEvmTx calling the registry." },
      },
      required: ["intent_id", "action", "expires_at", "summary", "policy", "simulation", "fee_disclosure", "unsigned"],
    },
    policy: { rules: ["network_mainnet_not_enabled", "chain_allowlist", "contract_allowlist", "intent_ttl", "simulation_required", "simulation_failed"] },
    receipt: true,
    fixtures: [...ERC8004_REGISTER_FIXTURES],
    upstream: { ...VIEM_PIN },
    sponsored: null,
  };
}

export async function buildErc8004Register(input: unknown, ctx: ActionContext): Promise<PrepareBuild> {
  const o = obj(input, ID);
  if (typeof o.chain !== "string" || !(ERC8004_CHAINS as readonly string[]).includes(o.chain)) {
    throw new ActionInputError(`${ID}: no ERC-8004 Identity Registry is deployed at ${ERC8004_IDENTITY_REGISTRY} on ${String(o.chain)}; supported: ${ERC8004_CHAINS.join(", ")}`);
  }
  const chain = o.chain as EvmChain;
  const owner = address(o.owner, "owner", ID);
  const uri = o.agent_uri;
  if (typeof uri !== "string" || uri.trim().length === 0 || uri.length > AGENT_URI_MAX || /\s/.test(uri)) {
    throw new ActionInputError(`${ID}: agent_uri must be a non-empty URI of at most ${AGENT_URI_MAX} characters with no whitespace`);
  }
  const unsigned: UnsignedEvmTx = {
    kind: "evm_tx", chain, chain_id: EVM_CHAIN_IDS[chain], from: owner, to: ERC8004_IDENTITY_REGISTRY,
    data: encodeFunctionData({ abi: ERC8004_REGISTER_ABI, functionName: "register", args: [uri] }), value: "0",
  };
  const params: Erc8004RegisterParams = { chain, owner, registry: ERC8004_IDENTITY_REGISTRY, agent_uri: uri };
  return {
    params,
    unsigned,
    facts: {
      action: ID, chain, network: ctx.policy.network,
      // register is non-payable: the value transferred is zero (gas is not counted here, as for every action).
      usd_value: 0, usd_spent_today: null, contract: ERC8004_IDENTITY_REGISTRY,
    },
    summary: `Register an ERC-8004 agent identity on ${chain}: call register(${JSON.stringify(uri)}) on ${ERC8004_IDENTITY_REGISTRY} from ${owner}; the identity is minted to ${owner}. No tokens are transferred.`,
    fee_disclosure: null,
  };
}

export function erc8004RegisterAction(): PrepareAction {
  return { descriptor: erc8004RegisterDescriptor(), build: buildErc8004Register };
}
