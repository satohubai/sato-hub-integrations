// ACTIONS builder. chain.read — one read-only query on an EVM chain through
// ctx.rpc(chain). Kinds: native_balance, erc20_balance, erc20_allowance,
// block_number, contract_read. contract_read takes one ABI function fragment
// and refuses anything that is not view or pure, so this action can never
// send a state-changing call.
import { erc20Abi } from "viem";
import type { Abi, AbiFunction } from "viem";
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor } from "../spec/index.js";
import type { ActionContext, ReadAction } from "../types.js";
import {
  ActionInputError, EVM_CHAINS, VIEM_PIN, address, addressSchema, chainSchema, evmChain, isoNow, jsonSafe, obj,
} from "./_util.js";
import type { EvmChain } from "./_util.js";

const ID = "chain.read";
export const CHAIN_READ_KINDS = ["native_balance", "erc20_balance", "erc20_allowance", "block_number", "contract_read"] as const;
export type ChainReadKind = (typeof CHAIN_READ_KINDS)[number];

export type ChainReadInput = {
  kind: ChainReadKind;
  chain: EvmChain;
  address?: string;
  token?: string;
  owner?: string;
  spender?: string;
  contract?: string;
  abi?: unknown;
  args?: unknown[];
};

export type ChainReadOutput = {
  kind: ChainReadKind;
  chain: EvmChain;
  block_number: string;
  /** bigints as decimal strings. */
  result: unknown;
  as_of: string;
};

export function chainReadDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Read chain state",
    description:
      "Reads one value from an EVM chain: a native balance, an ERC-20 balance or allowance, the latest block number, or the result of a view or pure contract function given its ABI fragment and arguments. Read-only: a function that is not view or pure is refused before any call is made. Amounts come back as base-unit decimal strings.",
    effects: ["read"],
    custody: { reads_key: false, sends_key: false, moves_funds: "never" },
    chains: [...EVM_CHAINS],
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...CHAIN_READ_KINDS] },
        chain: chainSchema(EVM_CHAINS),
        address: addressSchema("Account for native_balance."),
        token: addressSchema("ERC-20 contract for erc20_balance and erc20_allowance."),
        owner: addressSchema("Holder for erc20_balance and erc20_allowance."),
        spender: addressSchema("Spender for erc20_allowance."),
        contract: addressSchema("Contract for contract_read."),
        abi: {
          type: "object",
          description: "One ABI function fragment for contract_read; stateMutability must be view or pure.",
          properties: {
            type: { type: "string", enum: ["function"] },
            name: { type: "string" },
            inputs: { type: "array", items: { type: "object" } },
            outputs: { type: "array", items: { type: "object" } },
            stateMutability: { type: "string", enum: ["view", "pure"] },
          },
          required: ["type", "name", "inputs", "outputs", "stateMutability"],
        },
        args: { type: "array", description: "Arguments for contract_read; integers as decimal strings.", items: {} },
      },
      required: ["kind", "chain"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...CHAIN_READ_KINDS] },
        chain: chainSchema(EVM_CHAINS),
        block_number: { type: "string", description: "Block the read was answered at." },
        result: { description: "The value read; integers as decimal strings." },
        as_of: { type: "string" },
      },
      required: ["kind", "chain", "block_number", "result", "as_of"],
    },
    policy: { rules: [] },
    receipt: false,
    fixtures: [],
    upstream: { ...VIEM_PIN },
    sponsored: null,
  };
}

/** The fragment, checked: a single function that is view or pure. Anything else is refused. */
export function readOnlyFragment(abi: unknown): AbiFunction {
  if (typeof abi !== "object" || abi === null || Array.isArray(abi)) throw new ActionInputError(`${ID}: abi must be one function fragment object`);
  const f = abi as Partial<AbiFunction> & { constant?: unknown };
  if (f.type !== "function" || typeof f.name !== "string" || !f.name) throw new ActionInputError(`${ID}: abi must be a function fragment with a name`);
  if (f.stateMutability !== "view" && f.stateMutability !== "pure") {
    throw new ActionInputError(`${ID}: refused — ${f.name} is ${String(f.stateMutability ?? "undeclared")}; only view or pure functions can be read`);
  }
  if (!Array.isArray(f.inputs) || !Array.isArray(f.outputs)) throw new ActionInputError(`${ID}: abi needs inputs and outputs arrays`);
  return f as AbiFunction;
}

function coerceArgs(fn: AbiFunction, args: unknown): unknown[] {
  const list = args === undefined ? [] : args;
  if (!Array.isArray(list)) throw new ActionInputError(`${ID}: args must be an array`);
  if (list.length !== fn.inputs.length) throw new ActionInputError(`${ID}: ${fn.name} takes ${fn.inputs.length} argument(s), got ${list.length}`);
  return list.map((a, i) => {
    const t = fn.inputs[i]?.type ?? "";
    if (/^u?int\d*$/.test(t) && (typeof a === "string" || typeof a === "number")) return BigInt(a);
    return a;
  });
}

export async function chainRead(input: unknown, ctx: ActionContext): Promise<ChainReadOutput> {
  const o = obj(input, ID);
  const kind = o.kind as ChainReadKind;
  if (!CHAIN_READ_KINDS.includes(kind)) throw new ActionInputError(`${ID}: kind must be one of ${CHAIN_READ_KINDS.join(", ")}`);
  const chain = evmChain(o.chain, EVM_CHAINS, ID);
  // Validate everything BEFORE touching the RPC, so a refused read makes no call.
  let fn: AbiFunction | null = null;
  let args: unknown[] = [];
  if (kind === "contract_read") {
    address(o.contract, "contract", ID);
    fn = readOnlyFragment(o.abi);
    args = coerceArgs(fn, o.args);
  }
  const client = ctx.rpc(chain);
  const blockNumber = await client.getBlockNumber();
  let result: unknown;
  switch (kind) {
    case "block_number":
      result = blockNumber;
      break;
    case "native_balance":
      result = await client.getBalance({ address: address(o.address, "address", ID), blockNumber });
      break;
    case "erc20_balance":
      result = await client.readContract({ address: address(o.token, "token", ID), abi: erc20Abi, functionName: "balanceOf", args: [address(o.owner, "owner", ID)], blockNumber });
      break;
    case "erc20_allowance":
      result = await client.readContract({
        address: address(o.token, "token", ID), abi: erc20Abi, functionName: "allowance",
        args: [address(o.owner, "owner", ID), address(o.spender, "spender", ID)], blockNumber,
      });
      break;
    case "contract_read":
      result = await client.readContract({ address: o.contract as `0x${string}`, abi: [fn] as Abi, functionName: fn!.name, args, blockNumber });
      break;
  }
  return { kind, chain, block_number: blockNumber.toString(), result: jsonSafe(result), as_of: isoNow(ctx) };
}

export function chainReadAction(): ReadAction<unknown, ChainReadOutput> {
  return { descriptor: chainReadDescriptor(), run: chainRead };
}
