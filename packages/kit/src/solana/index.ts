// Solana JSON-RPC seam (Phase 2 wave 2). Thin wrappers over the official
// JSON-RPC methods simulateTransaction / sendTransaction / getGenesisHash.
// No dependency: the RPC is plain JSON over fetch, and tests inject a fake.
import type { SimulationResult, UnsignedSolanaTx } from "../spec/index.js";
import type { ActionContext, KitFetch, SignedSolanaTx, SolanaRpc } from "../types.js";

/** Genesis hash of Solana mainnet-beta. A devnet-only signer refuses an RPC that reports it. */
export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export class SolanaRpcError extends Error {
  constructor(method: string, public readonly code: number | null, message: string) {
    super(`solana rpc ${method}: ${message}`);
    this.name = "SolanaRpcError";
  }
}

/** A fetch-backed SolanaRpc for one endpoint URL. Each call times out after `timeoutMs` (default 15 s). */
export function solanaJsonRpc(url: string, opts: { fetch?: KitFetch; timeoutMs?: number; userAgent?: string } = {}): SolanaRpc {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  let id = 0;
  return {
    async request(method, params) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.userAgent) headers["user-agent"] = opts.userAgent;
      const res = await f(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (!res.ok) throw new SolanaRpcError(method, null, `HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
      if (body.error) throw new SolanaRpcError(method, body.error.code ?? null, body.error.message ?? "error");
      return body.result;
    },
  };
}

type SimulateValue = { err: unknown; logs?: string[] | null; unitsConsumed?: number | null };

/**
 * Simulates an unsigned Solana transaction with simulateTransaction
 * (sigVerify false, the blockhash in the transaction kept as is). ok only when
 * the RPC reports `err: null`. `gas_estimate` carries unitsConsumed (compute
 * units), `block` the slot simulated against.
 */
export async function simulateSolanaTx(tx: UnsignedSolanaTx, ctx: Pick<ActionContext, "solanaRpc" | "clock">): Promise<SimulationResult> {
  if (!ctx.solanaRpc) throw new Error("no Solana RPC configured (pass solanaRpc to createKit)");
  const rpc = ctx.solanaRpc(tx.chain);
  const out = (await rpc.request("simulateTransaction", [
    tx.transaction_base64,
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" },
  ])) as { context?: { slot?: number }; value?: SimulateValue } | null;
  const value = out?.value;
  if (!value || !("err" in value)) throw new Error("simulateTransaction returned no value");
  const ok = value.err === null;
  return {
    ok,
    method: "simulateTransaction",
    block: typeof out?.context?.slot === "number" ? String(out.context.slot) : null,
    gas_estimate: typeof value.unitsConsumed === "number" ? String(value.unitsConsumed) : null,
    error: ok ? null : describeSolanaErr(value.err, value.logs ?? null),
    as_of: new Date(ctx.clock()).toISOString(),
  };
}

function describeSolanaErr(err: unknown, logs: string[] | null): string {
  const e = typeof err === "string" ? err : JSON.stringify(err);
  const last = logs?.filter((l) => /failed|error/i.test(l)).slice(-1)[0];
  return last ? `${e} (${last})` : e;
}

/** Sends an already-signed transaction (base64 wire bytes) with sendTransaction; returns the signature. */
export async function sendSignedSolanaTx(rpc: SolanaRpc, signed: SignedSolanaTx): Promise<string> {
  const sig = await rpc.request("sendTransaction", [signed.transaction_base64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }]);
  if (typeof sig !== "string") throw new Error("sendTransaction returned no signature");
  return sig;
}
