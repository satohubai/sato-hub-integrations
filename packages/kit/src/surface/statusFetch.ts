// Reads Sato Status (actions-status.json) from the templates repo's `status`
// branch, falling back to the frozen copy on main ONLY when the status branch
// answers 404. Any other failure (5xx, timeout, bad JSON) is reported as-is and
// never silently replaced by the main copy, which may be stale.
import { ACTIONS_STATUS_FALLBACK_URL, ACTIONS_STATUS_URL } from "./tools.js";

export type StatusFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface StatusRead {
  doc: unknown | null;
  /** The URL whose answer is in `doc` (or that failed last). */
  url: string;
  /** "status-branch" | "main-fallback" when a document was read; null otherwise. */
  source: "status-branch" | "main-fallback" | null;
  reason?: string;
}

export async function readActionsStatusDoc(
  f: StatusFetch,
  opts: { timeoutMs: number; headers?: Record<string, string>; primaryUrl?: string; fallbackUrl?: string | null } ,
): Promise<StatusRead> {
  const primary = opts.primaryUrl ?? ACTIONS_STATUS_URL;
  const fallback = opts.fallbackUrl === undefined ? ACTIONS_STATUS_FALLBACK_URL : opts.fallbackUrl;
  const headers = { accept: "application/json", ...(opts.headers ?? {}) };
  const one = async (url: string): Promise<{ doc: unknown | null; status?: number; reason?: string }> => {
    try {
      const res = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs), headers });
      if (!res.ok) return { doc: null, status: res.status, reason: `Sato Status answered HTTP ${res.status} at ${url}` };
      return { doc: await res.json() };
    } catch (e) {
      const err = e as Error;
      const reason = err.name === "TimeoutError" || err.name === "AbortError"
        ? `Sato Status did not answer within ${opts.timeoutMs / 1000} s at ${url}`
        : `Sato Status could not be read at ${url}: ${err.message}`;
      return { doc: null, reason };
    }
  };
  const a = await one(primary);
  if (a.doc !== null) return { doc: a.doc, url: primary, source: "status-branch" };
  if (a.status === 404 && fallback) {
    const b = await one(fallback);
    if (b.doc !== null) return { doc: b.doc, url: fallback, source: "main-fallback" };
    return { doc: null, url: fallback, source: null, reason: `status branch answered 404; fallback: ${b.reason}` };
  }
  return { doc: null, url: primary, source: null, reason: a.reason };
}
