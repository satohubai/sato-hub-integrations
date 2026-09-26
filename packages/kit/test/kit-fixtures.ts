// Shared fakes for the intent/receipts/kit tests. No network, no keys.
import { POLICY_DEFAULTS, POLICY_SCHEMA_ID } from "../src/spec/index.js";
import type { ActionDescriptor, SatoPolicy, SimulationResult, UnsignedEvmTx } from "../src/spec/index.js";
import type { EvaluatePreflight, PrepareAction, ReadAction, RpcProvider, Signer } from "../src/types.js";

export const SECRET = new Uint8Array(32).fill(7);
export const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);
export const policy: SatoPolicy = { schema: POLICY_SCHEMA_ID, version: 1, ...POLICY_DEFAULTS } as SatoPolicy;
export const rpc: RpcProvider = () => { throw new Error("no rpc in tests"); };

export function descriptor(id: string, effects: ActionDescriptor["effects"], title = id): ActionDescriptor {
  return {
    schema: "sato.action/v1", id, name: id.replace(/\./g, "_"), version: "0.1.0", title, description: "Test action.",
    effects, custody: { reads_key: false, sends_key: false, moves_funds: "with_approval" }, chains: ["base-sepolia"],
    input_schema: { type: "object" }, output_schema: { type: "object" }, policy: { rules: [] }, receipt: true,
    fixtures: [], upstream: {}, sponsored: null,
  };
}

export const tx: UnsignedEvmTx = { kind: "evm_tx", chain: "base-sepolia", chain_id: 84532, from: null, to: "0x000000000000000000000000000000000000dEaD", data: "0x", value: "1000" };

export const sendAction: PrepareAction<{ amount: string }> = {
  descriptor: descriptor("test.send", ["sign", "broadcast"], "Send a test transfer"),
  async build(input) {
    return {
      params: { amount: input.amount },
      unsigned: { ...tx, value: input.amount },
      facts: { action: "test.send", chain: "base-sepolia", network: "fork", usd_value: 1, usd_spent_today: 0 },
      summary: `Send ${input.amount} wei`,
      fee_disclosure: null,
    };
  },
};

export const readAction: ReadAction<{ x: number }, { y: number }> = {
  descriptor: descriptor("test.read", ["read"], "Read a number"),
  async run(input) { return { y: input.x * 2 }; },
};

export const okSim: SimulationResult = { ok: true, method: "eth_call", block: "1", gas_estimate: "21000", error: null, as_of: new Date(T0).toISOString() };

/** Refuses simulation_required when simulation is null, otherwise ok; records call order. */
export function fakeEvaluator(calls: string[], extra: { refuseAll?: boolean } = {}): EvaluatePreflight {
  return (_p, facts) => {
    calls.push(`evaluate:${facts.simulation ? "sim" : "nosim"}`);
    if (extra.refuseAll) return { ok: false, refusals: [{ rule: "max_usd_per_trade", limit: "0", observed: "1", message: "Trade over the per-trade limit." }] };
    if (!facts.simulation) return { ok: false, refusals: [{ rule: "simulation_required", limit: "simulated", observed: "not simulated", message: "Not simulated." }] };
    return { ok: true, refusals: [] };
  };
}

export function fakeSigner(sent: UnsignedEvmTx[], fail = false): Signer {
  return {
    kind: "viem-local",
    async address() { return "0x0000000000000000000000000000000000000001"; },
    async sendTransaction(t) {
      if (fail) throw new Error("rpc down");
      sent.push(t);
      return { tx_hash: `0x${String(sent.length).padStart(64, "0")}` as `0x${string}` };
    },
    async signTypedData() { return "0x"; },
  };
}
