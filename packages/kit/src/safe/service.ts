// Safe Transaction Service gateway settings (Phase 2 wave 3).
// Safe's gateway at api.safe.global takes an API key as
//   Authorization: Bearer <key>
// (docs.safe.global/core-api/how-to-use-api-keys). The key is optional here,
// read from SAFE_API_KEY only when the caller opts in, sent only to the
// gateway origins the caller configured (or api.safe.global), and never logged
// or written to a receipt.
import type { SafeTxServiceOptions } from "../types.js";

export const SAFE_TX_SERVICE_BASE = "https://api.safe.global/tx-service";
export const SAFE_API_KEY_ENV = "SAFE_API_KEY";

/** The resolved settings the kit carries in its ActionContext. */
export type ResolvedSafeTxService = { apiKey?: string; baseUrl: Partial<Record<string, string>> };

export function resolveSafeTxService(
  opts: SafeTxServiceOptions | undefined,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): ResolvedSafeTxService {
  const baseUrl: Partial<Record<string, string>> = {};
  for (const [chain, url] of Object.entries(opts?.baseUrl ?? {})) {
    if (typeof url !== "string" || !url) continue;
    const u = new URL(url);
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      throw new Error(`safeTxService.baseUrl for ${chain} must be https`);
    }
    baseUrl[chain] = url.replace(/\/+$/, "");
  }
  let apiKey = typeof opts?.apiKey === "string" && opts.apiKey ? opts.apiKey : undefined;
  if (!apiKey && opts?.apiKeyFromEnv) {
    const v = env[SAFE_API_KEY_ENV];
    if (typeof v === "string" && v.trim()) apiKey = v.trim();
  }
  return apiKey ? { apiKey, baseUrl } : { baseUrl };
}

/** Base URL of the service for a chain: the caller's override, else Safe's gateway. */
export function serviceBaseFor(shortName: string, chain: string, s?: ResolvedSafeTxService): string {
  return s?.baseUrl[chain] ?? `${SAFE_TX_SERVICE_BASE}/${shortName}`;
}

/**
 * The API key to send to `url`, or undefined. Sent only when `url` is on Safe's
 * gateway origin or on an origin the caller configured, so a payload's submit
 * URL pointing elsewhere never receives it.
 */
export function safeApiKeyFor(s: ResolvedSafeTxService | undefined, url: string): string | undefined {
  if (!s?.apiKey) return undefined;
  let origin: string;
  try { origin = new URL(url).origin; } catch { return undefined; }
  const allowed = new Set([new URL(SAFE_TX_SERVICE_BASE).origin]);
  for (const b of Object.values(s.baseUrl)) if (b) allowed.add(new URL(b).origin);
  return allowed.has(origin) ? s.apiKey : undefined;
}

/** Header object for a request to `url` (empty when no key applies). */
export function safeAuthHeaders(s: ResolvedSafeTxService | undefined, url: string): Record<string, string> {
  const k = safeApiKeyFor(s, url);
  return k ? { authorization: `Bearer ${k}` } : {};
}
