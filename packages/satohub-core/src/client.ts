/**
 * One thin client over the public Sato Hub surfaces. Every framework package in
 * this repo calls this and nothing else, so a fix lands once.
 *
 * IT WRAPS, IT NEVER RE-IMPLEMENTS. No scoring, no ranking and no verdict logic
 * lives here. Sato Hub decides; this code carries the answer across the wire
 * and checks the signature on it.
 *
 * WHICH WIRE, AND WHY
 *  - `searchResources` → `POST /api/mcp` (JSON-RPC, Streamable HTTP). The
 *    free-text search lives on the MCP surface; the bulk export is a filtered
 *    mirror of the catalogue, not a search, so using it here would quietly
 *    change the question being asked.
 *  - `preflight`, `routeSwap`, `buildPlan` → the REST routes, which are the
 *    documented public API and are Ed25519-signed.
 *
 * NON-CUSTODIAL. Nothing here signs a transaction, holds a key, deploys or
 * moves funds. `routeSwap` returns a quote and calldata the caller may read and
 * sign itself; a route that is never signed costs nothing.
 */

import { verifyBodySignature, verifyResponseSignature, type Jwks, type VerifyResult } from "./verify.js";

export const DEFAULT_BASE_URL = "https://satohub.ai";

/** Minimal fetch shape, so a caller can inject one (and a test can mock it). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SignatureCheck =
  /** The bytes received are the bytes Sato Hub signed, at `signed_at`. */
  | { state: "verified"; kid: string; signed_at: string }
  /** No signature travelled with this response. Unknown, not invalid. */
  | { state: "unsigned"; reason: string }
  /** Verification was not attempted (`verify: false`, or no JWKS reachable). */
  | { state: "skipped"; reason: string }
  /** A signature was present and did not match. */
  | { state: "failed"; reason: string };

export type SatoResponse<T> = {
  /** The response body, exactly as Sato Hub sent it. */
  data: T;
  /** What the signature on those bytes proved — origin, integrity and time. */
  signature: SignatureCheck;
};

/** Thrown when a signature was present and did not match the bytes. */
export class SatoSignatureError extends Error {
  constructor(public readonly reason: string) {
    super(`Sato Hub response failed signature verification: ${reason}`);
    this.name = "SatoSignatureError";
  }
}

/** Thrown for a non-2xx response. Carries the status and the body text. */
export class SatoHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    url: string,
  ) {
    super(`Sato Hub answered ${status} for ${url}`);
    this.name = "SatoHttpError";
  }
}

export type SatoHubClientOptions = {
  /** Override for a preview deployment. Defaults to https://satohub.ai */
  baseUrl?: string;
  jwksUrl?: string;
  fetch?: FetchLike;
  /** Per-request deadline in ms. Default 20000. */
  timeoutMs?: number;
  /**
   * `"throw"` (default) verifies and throws on a mismatch; `"report"` verifies
   * and only reports; `false` does not fetch the JWKS at all. An UNSIGNED
   * response never throws under any setting — absent is unknown, not invalid.
   */
  verify?: "throw" | "report" | false;
  /**
   * Identifies your integration in our logs. Please set it — it is the only
   * thing that distinguishes a caller from a scanner.
   */
  userAgent?: string;
};

export type SearchResourcesInput = {
  query?: string;
  chain?: string;
  use_case?: string;
  standard?: string;
  iface?: string;
  status?: string;
  liveness?: string;
  sort?: "priority" | "newest_release" | "stars" | "name";
  limit?: number;
  offset?: number;
};

export type PreflightInput = {
  repo?: string;
  package?: string;
  endpoint?: string;
  agent?: string;
  token?: string;
  chain?: string;
  skill?: string;
};

export type RouteSwapInput = {
  chain: string;
  token_in: string;
  token_out: string;
  /** Integer amount in the input token's smallest unit, as a string. */
  amount: string;
  slippage_bps?: number;
  taker?: string;
};

export type BuildPlanInput = {
  goal: string;
  chain?: string;
  budget_usd?: number;
  constraints?: string;
};

const JWKS_TTL_MS = 10 * 60 * 1000;

export class SatoHubClient {
  readonly baseUrl: string;
  readonly jwksUrl: string;
  private readonly doFetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly verifyMode: "throw" | "report" | false;
  private readonly userAgent: string;
  private jwksCache: { at: number; jwks: Jwks } | null = null;

  constructor(opts: SatoHubClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.jwksUrl = opts.jwksUrl ?? `${this.baseUrl}/.well-known/jwks.json`;
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error("No fetch available. Pass one as options.fetch (Node 18+ has a global).");
    this.doFetch = f;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.verifyMode = opts.verify ?? "throw";
    this.userAgent = opts.userAgent ?? "satohub-integrations";
  }

  // ── the four calls ───────────────────────────────────────────────────────

  /**
   * Search the daily-rebuilt index of what onchain agents are built from.
   * Read-only. Deprecated listings are never returned.
   */
  async searchResources(input: SearchResourcesInput = {}): Promise<SatoResponse<unknown>> {
    return this.callMcpTool("onchain_agent_search_resources", {
      ...prune(input),
      response_format: "json",
    });
  }

  /**
   * One check before installing, connecting, paying or trading. Pass exactly
   * one target. A verdict names WHAT WAS CHECKED AND WHEN — never a security
   * review, and `unknown` means Sato Hub holds no record, not that something is
   * wrong.
   */
  async preflight(input: PreflightInput): Promise<SatoResponse<unknown>> {
    const given = ["repo", "package", "endpoint", "agent", "token", "skill"].filter(
      (k) => (input as Record<string, unknown>)[k],
    );
    if (given.length !== 1) {
      throw new Error("Pass exactly one of repo, package, endpoint, agent, token or skill.");
    }
    return this.getJson("/api/preflight", prune(input));
  }

  /**
   * Choose a venue for a swap, with the fee disclosed. A route is a
   * RECOMMENDATION, not a verdict and not an assurance; a quote is a quote, not
   * a fill. This never signs or broadcasts anything.
   */
  async routeSwap(input: RouteSwapInput): Promise<SatoResponse<unknown>> {
    if (input.token_in.trim().toLowerCase() === input.token_out.trim().toLowerCase()) {
      throw new Error("token_in and token_out must differ.");
    }
    return this.getJson("/api/route/swap", prune(input));
  }

  /**
   * A goal in plain words → a build plan of REAL directory listings, each with
   * its deploy spec and Preflight verdict. Nothing in a plan is invented.
   */
  async buildPlan(input: BuildPlanInput): Promise<SatoResponse<unknown>> {
    if (!input.goal?.trim()) throw new Error("goal is required.");
    return this.getJson("/api/satobot/plan", prune(input));
  }

  // ── wire ─────────────────────────────────────────────────────────────────

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "user-agent": this.userAgent, accept: "application/json", ...extra };
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  /** A signed REST GET: read the BYTES, verify, then parse. Never the reverse. */
  private async getJson(path: string, params: Record<string, unknown>): Promise<SatoResponse<unknown>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await this.doFetch(url.toString(), { headers: this.headers(), signal: this.signal() });
    const text = await res.text();
    if (!res.ok) throw new SatoHttpError(res.status, text.slice(0, 2000), url.toString());
    const signature = await this.checkHeaderSignature(text, res.headers);
    return { data: JSON.parse(text) as unknown, signature };
  }

  /**
   * One stateless JSON-RPC `tools/call` against the Streamable HTTP MCP
   * endpoint. The server answers with a single SSE frame; we read the one
   * `data:` line rather than pulling in an SDK to unwrap it.
   */
  private async callMcpTool(name: string, args: Record<string, unknown>): Promise<SatoResponse<unknown>> {
    const url = `${this.baseUrl}/api/mcp`;
    const res = await this.doFetch(url, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: this.signal(),
    });
    const text = await res.text();
    if (!res.ok) throw new SatoHttpError(res.status, text.slice(0, 2000), url);
    const envelope = parseJsonRpcFrame(text);
    if (envelope.error) throw new Error(`MCP error from ${name}: ${envelope.error.message ?? "unknown"}`);
    const result = envelope.result as
      | { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }
      | undefined;
    const data = result?.structuredContent ?? firstTextAsJson(result?.content) ?? null;
    // MCP carries no HTTP signature header, so the only thing to check is the
    // embedded meta.signature — present on the signed payloads, absent here.
    const signature = await this.checkBodySignature(data);
    return { data, signature };
  }

  // ── signatures ───────────────────────────────────────────────────────────

  private async jwks(): Promise<Jwks | null> {
    if (this.jwksCache && Date.now() - this.jwksCache.at < JWKS_TTL_MS) return this.jwksCache.jwks;
    try {
      const res = await this.doFetch(this.jwksUrl, { headers: this.headers(), signal: this.signal() });
      if (!res.ok) return null;
      const jwks = (await res.json()) as Jwks;
      if (!Array.isArray(jwks?.keys)) return null;
      this.jwksCache = { at: Date.now(), jwks };
      return jwks;
    } catch {
      return null;
    }
  }

  private async checkHeaderSignature(body: string, headers: Headers): Promise<SignatureCheck> {
    if (this.verifyMode === false) return { state: "skipped", reason: "verify is disabled on this client." };
    if (!headers.get("Sato-Signature")) {
      return { state: "unsigned", reason: "No Sato-Signature header. Unknown, not invalid." };
    }
    const jwks = await this.jwks();
    if (!jwks) return { state: "skipped", reason: `Could not read the JWKS at ${this.jwksUrl}.` };
    return this.settle(verifyResponseSignature(body, headers, jwks));
  }

  private async checkBodySignature(data: unknown): Promise<SignatureCheck> {
    if (this.verifyMode === false) return { state: "skipped", reason: "verify is disabled on this client." };
    const meta = (data as { meta?: { signature?: unknown } } | null)?.meta;
    if (!meta || meta.signature === undefined) {
      return { state: "unsigned", reason: "This surface carries no meta.signature block. Unknown, not invalid." };
    }
    const jwks = await this.jwks();
    if (!jwks) return { state: "skipped", reason: `Could not read the JWKS at ${this.jwksUrl}.` };
    return this.settle(verifyBodySignature(data, jwks));
  }

  private settle(result: VerifyResult): SignatureCheck {
    if (result.ok) return { state: "verified", kid: result.kid, signed_at: result.signed_at };
    if (this.verifyMode === "throw") throw new SatoSignatureError(result.reason);
    return { state: "failed", reason: result.reason };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function prune<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

/**
 * The endpoint answers either plain JSON or a single SSE frame. Read whichever
 * arrived; do not require an SDK to unwrap one `data:` line.
 */
export function parseJsonRpcFrame(text: string): { result?: unknown; error?: { message?: string } } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const line = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .find((l) => l.startsWith("{"));
  if (!line) throw new Error("Could not read a JSON-RPC frame from the MCP response.");
  return JSON.parse(line);
}

function firstTextAsJson(content: Array<{ type: string; text?: string }> | undefined): unknown {
  const text = content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
