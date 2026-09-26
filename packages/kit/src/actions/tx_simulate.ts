// ACTIONS builder. tx.simulate — run an unsigned EVM transaction against the
// chain with eth_call + eth_estimateGas. Read-only: nothing is signed or sent.
//
// A failure is never reported as ok. A revert comes back ok:false with the
// reason; an RPC that cannot be reached comes back ok:false, error
// "rpc_unreachable" — "we could not check" never looks like "it passed".
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, SimulationResult, UnsignedEvmTx } from "../spec/index.js";
import type { ActionContext, ReadAction } from "../types.js";
import {
  ADDRESS_PATTERN, BASE_UNITS_PATTERN, EVM_CHAINS, EVM_CHAIN_IDS, HEX_PATTERN, VIEM_PIN,
  address, baseUnits, chainSchema, classifyRpcError, evmChain, hex, isoNow, obj, optAddress,
} from "./_util.js";

const ID = "tx.simulate";

export const SIMULATION_METHOD = "eth_call+eth_estimateGas";

/** Simulate one unsigned EVM transaction on ctx.rpc(chain). Never throws; never ok on failure. */
export async function simulateTx(unsigned: UnsignedEvmTx, ctx: ActionContext): Promise<SimulationResult> {
  const as_of = isoNow(ctx);
  const fail = (error: string, block: string | null = null): SimulationResult => ({ ok: false, method: SIMULATION_METHOD, block, gas_estimate: null, error, as_of });
  const chain = unsigned.chain as keyof typeof EVM_CHAIN_IDS;
  if (!(chain in EVM_CHAIN_IDS)) return fail(`unsupported_chain: ${unsigned.chain}`);
  let client;
  try {
    client = ctx.rpc(chain);
  } catch {
    return fail("rpc_unreachable");
  }
  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber();
  } catch (e) {
    const c = classifyRpcError(e);
    return fail(c.kind === "unreachable" ? "rpc_unreachable" : `rpc_error: ${c.reason}`);
  }
  const block = blockNumber.toString();
  const req = {
    account: unsigned.from ? (unsigned.from as `0x${string}`) : undefined,
    to: unsigned.to as `0x${string}`,
    data: unsigned.data as `0x${string}`,
    value: BigInt(unsigned.value || "0"),
  };
  try {
    await client.call({ ...req, blockNumber });
  } catch (e) {
    const c = classifyRpcError(e);
    if (c.kind === "unreachable") return fail("rpc_unreachable", block);
    return fail(c.kind === "revert" ? `reverted: ${c.reason}` : `call_failed: ${c.reason}`, block);
  }
  let gas: bigint;
  try {
    gas = await client.estimateGas(req);
  } catch (e) {
    const c = classifyRpcError(e);
    if (c.kind === "unreachable") return fail("rpc_unreachable", block);
    return fail(c.kind === "revert" ? `reverted: ${c.reason}` : `estimate_gas_failed: ${c.reason}`, block);
  }
  return { ok: true, method: SIMULATION_METHOD, block, gas_estimate: gas.toString(), error: null, as_of };
}

export function txSimulateDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Simulate a transaction",
    description:
      "Runs an unsigned EVM transaction against the latest block with eth_call and eth_estimateGas and reports whether it would succeed, the gas estimate and the block it was run on. Nothing is signed or sent. A revert returns ok false with the reason; an RPC that cannot be reached returns ok false with error rpc_unreachable, never ok true.",
    effects: ["simulate"],
    custody: { reads_key: false, sends_key: false, moves_funds: "never" },
    chains: [...EVM_CHAINS],
    input_schema: {
      type: "object",
      properties: {
        chain: chainSchema(EVM_CHAINS),
        from: { type: "string", pattern: ADDRESS_PATTERN, description: "Sender to simulate as. Optional." },
        to: { type: "string", pattern: ADDRESS_PATTERN, description: "Destination contract or account." },
        data: { type: "string", pattern: HEX_PATTERN, description: "0x-prefixed calldata." },
        value: { type: "string", pattern: BASE_UNITS_PATTERN, description: "Wei as a decimal string. Defaults to 0." },
      },
      required: ["chain", "to", "data"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        method: { type: "string" },
        block: { description: "Block number simulated against (decimal string), or null." },
        gas_estimate: { description: "Gas estimate (decimal string), or null when not ok." },
        error: { description: "Revert reason, rpc_unreachable, or another error; null when ok." },
        as_of: { type: "string", description: "ISO-8601 time of the simulation." },
      },
      required: ["ok", "method", "block", "gas_estimate", "error", "as_of"],
    },
    policy: { rules: [] },
    receipt: false,
    fixtures: [],
    upstream: { ...VIEM_PIN },
    sponsored: null,
  };
}

function parse(input: unknown): UnsignedEvmTx {
  const o = obj(input, ID);
  const chain = evmChain(o.chain, EVM_CHAINS, ID);
  return {
    kind: "evm_tx",
    chain,
    chain_id: EVM_CHAIN_IDS[chain],
    from: optAddress(o.from, "from", ID),
    to: address(o.to, "to", ID),
    data: hex(o.data, "data", ID),
    value: o.value === undefined ? "0" : baseUnits(o.value, "value", ID),
  };
}

export function txSimulateAction(): ReadAction<unknown, SimulationResult> {
  return {
    descriptor: txSimulateDescriptor(),
    run: async (input, ctx) => simulateTx(parse(input), ctx),
  };
}
