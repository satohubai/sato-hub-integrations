// ACTIONS builder. Shared pieces for the core actions: chain ids, schema
// fragments, input checks and the one HTTP helper every action uses (so the
// user-agent rides on every request, and tests replay through ctx.fetch).
import type { OdaChain, Refusal } from "../spec/index.js";
import type { ActionContext } from "../types.js";

/** The EVM chains the core actions touch, with their chain ids. */
export const EVM_CHAIN_IDS = {
  ethereum: 1,
  sepolia: 11155111,
  base: 8453,
  "base-sepolia": 84532,
  arbitrum: 42161,
  "arbitrum-sepolia": 421614,
  optimism: 10,
  "optimism-sepolia": 11155420,
  polygon: 137,
} as const satisfies Partial<Record<OdaChain, number>>;
export type EvmChain = keyof typeof EVM_CHAIN_IDS;
export const EVM_CHAINS = Object.keys(EVM_CHAIN_IDS) as EvmChain[];

/** Mainnets both swap venues quote on. */
export const SWAP_CHAINS: EvmChain[] = ["ethereum", "base", "arbitrum", "optimism", "polygon"];

/** Exact versions of what the actions wrap. viem is the pinned devDependency. */
export const VIEM_PIN = { viem: "2.56.9" } as const;

export const ADDRESS_PATTERN = "^0x[0-9a-fA-F]{40}$";
export const BASE_UNITS_PATTERN = "^[0-9]{1,78}$";
export const HEX_PATTERN = "^0x[0-9a-fA-F]*$";

const ADDRESS_RE = new RegExp(ADDRESS_PATTERN);
const BASE_UNITS_RE = new RegExp(BASE_UNITS_PATTERN);
const HEX_RE = new RegExp(HEX_PATTERN);

export const addressSchema = (description: string) => ({ type: "string", pattern: ADDRESS_PATTERN, description });
export const baseUnitsSchema = (description: string) => ({ type: "string", pattern: BASE_UNITS_PATTERN, description });
export const chainSchema = (chains: readonly string[], description = "Chain name.") => ({ type: "string", enum: [...chains], description });

export class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

/** A prepare that found nothing it may build. Carries the refusals, each naming its rule. */
export class ActionRefusedError extends Error {
  readonly refusals: Refusal[];
  constructor(message: string, refusals: Refusal[]) {
    super(message);
    this.name = "ActionRefusedError";
    this.refusals = refusals;
  }
}

export function obj(input: unknown, action: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ActionInputError(`${action}: input must be an object`);
  return input as Record<string, unknown>;
}

export function evmChain(v: unknown, allowed: readonly string[], action: string): EvmChain {
  if (typeof v !== "string" || !allowed.includes(v)) throw new ActionInputError(`${action}: chain must be one of ${allowed.join(", ")}`);
  return v as EvmChain;
}

export function address(v: unknown, field: string, action: string): `0x${string}` {
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) throw new ActionInputError(`${action}: ${field} must be a 0x address (40 hex characters)`);
  return v as `0x${string}`;
}

export function optAddress(v: unknown, field: string, action: string): `0x${string}` | null {
  return v === undefined || v === null ? null : address(v, field, action);
}

export function baseUnits(v: unknown, field: string, action: string): string {
  if (typeof v !== "string" || !BASE_UNITS_RE.test(v)) throw new ActionInputError(`${action}: ${field} must be base units as a decimal string`);
  return v;
}

export function hex(v: unknown, field: string, action: string): `0x${string}` {
  if (typeof v !== "string" || !HEX_RE.test(v)) throw new ActionInputError(`${action}: ${field} must be 0x-prefixed hex`);
  return v as `0x${string}`;
}

export function slippage(v: unknown, action: string, dflt = 50): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 5000) throw new ActionInputError(`${action}: slippage_bps must be an integer 0..5000`);
  return v;
}

export function isoNow(ctx: ActionContext): string {
  return new Date(ctx.clock()).toISOString();
}

/** Deep-convert bigints to decimal strings so a result survives JSON. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

export type HttpResult = { status: number; headers: Headers; body: unknown; text: string };

/** One HTTP call through ctx.fetch, always with the kit's user-agent. Never throws on a non-2xx. */
export async function http(ctx: ActionContext, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { "user-agent": ctx.userAgent, accept: "application/json", ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await ctx.fetch(url, { method: init.method ?? "GET", headers, body, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { shortMessage?: unknown; message?: unknown };
    if (typeof o.shortMessage === "string") return o.shortMessage;
    if (typeof o.message === "string") return o.message;
  }
  return String(e);
}

/** Error names viem uses when the RPC could not be reached at all. */
const UNREACHABLE = new Set(["HttpRequestError", "TimeoutError", "WebSocketRequestError", "SocketClosedError", "RpcRequestError_unreachable"]);

/** Walks an error's cause chain: "unreachable" when transport failed, "revert" when the chain said no. */
export function classifyRpcError(e: unknown): { kind: "unreachable" | "revert" | "other"; reason: string } {
  let cur: unknown = e;
  let revertReason: string | null = null;
  for (let i = 0; cur && i < 10; i++) {
    const o = cur as { name?: unknown; reason?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown; details?: unknown };
    const name = typeof o.name === "string" ? o.name : "";
    if (UNREACHABLE.has(name)) return { kind: "unreachable", reason: "rpc_unreachable" };
    if (/Revert/i.test(name)) {
      revertReason = typeof o.reason === "string" && o.reason ? o.reason : errorMessage(cur);
    }
    cur = o.cause;
  }
  if (revertReason !== null) return { kind: "revert", reason: revertReason };
  const msg = errorMessage(e);
  if (/revert/i.test(msg)) return { kind: "revert", reason: msg };
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|timed? ?out|network/i.test(msg)) return { kind: "unreachable", reason: "rpc_unreachable" };
  return { kind: "other", reason: msg };
}
