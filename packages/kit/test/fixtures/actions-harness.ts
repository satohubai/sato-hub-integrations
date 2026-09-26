// Offline harness for the actions tests: a recording fake fetch, a fake RPC,
// a fixed clock, and fixture loading. Nothing here touches the network.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PublicClient } from "viem";
import { parsePolicyFile } from "../../src/spec/index.js";
import type { SatoPolicy } from "../../src/spec/index.js";
import type { ActionContext } from "../../src/types.js";

/** Compiled to .test-build/test/fixtures; the JSON stays in test/fixtures. */
export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(PKG_ROOT, "test", "fixtures", name), "utf8")) as T;
}

export type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };
export type Route = { match: (url: string) => boolean; status?: number; body?: unknown; headers?: Record<string, string> };

export function fakeFetch(routes: Route[]) {
  const calls: Recorded[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = routes.find((x) => x.match(url));
    if (!r) throw new TypeError(`fetch failed: no fixture for ${url}`);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const DEFAULT_POLICY: SatoPolicy = (() => {
  const p = parsePolicyFile({ schema: "sato.policy/v1", version: 1 });
  if (!p.ok) throw new Error(p.error);
  return p.policy;
})();

export const FIXED_NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
export const TEST_UA = "@satohub/kit/0.1.0";

/** A fake PublicClient: only the methods the actions call. Unset methods throw if touched. */
export function fakeClient(impl: Partial<Record<"getBlockNumber" | "call" | "estimateGas" | "readContract" | "getBalance", (...a: any[]) => Promise<any>>>) {
  const touched: string[] = [];
  const client = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return undefined;
      const f = (impl as Record<string, unknown>)[prop];
      return async (...a: unknown[]) => {
        touched.push(prop);
        if (typeof f !== "function") throw new Error(`fake client: ${prop} not stubbed`);
        return (f as (...x: unknown[]) => unknown)(...a);
      };
    },
  }) as unknown as PublicClient;
  return { client, touched };
}

export function ctxWith(opts: { fetch?: typeof fetch; client?: PublicClient; rpcThrows?: boolean; policy?: SatoPolicy; extra?: Record<string, unknown> } = {}): ActionContext {
  return {
    fetch: opts.fetch ?? fakeFetch([]).fetch,
    clock: () => FIXED_NOW,
    rpc: () => {
      if (opts.rpcThrows || !opts.client) throw new Error("no rpc in this test");
      return opts.client;
    },
    policy: opts.policy ?? DEFAULT_POLICY,
    userAgent: TEST_UA,
    ...(opts.extra ?? {}),
  } as ActionContext;
}
