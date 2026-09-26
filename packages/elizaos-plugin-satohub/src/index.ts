/**
 * elizaos-plugin-satohub — Sato Hub as four elizaOS actions.
 *
 * Each action is a thin call to satohub.ai and a renderer. No scoring, no
 * ranking and no verdict logic lives here: Sato Hub decides, the plugin carries
 * the answer, and the Ed25519 signature on the response is checked on the way
 * through (`satohub-core`). An unsigned response is reported as unsigned —
 * unknown, not invalid — and a response whose signature does not match the
 * bytes fails the action rather than being spoken as fact.
 *
 * NON-CUSTODIAL. Nothing here signs a transaction, holds a key, deploys or
 * moves funds. The swap action returns a QUOTE and calldata for the operator to
 * read and sign with its own signer; a route that is never signed costs
 * nothing.
 *
 * Settings read from the runtime (all optional):
 *   SATOHUB_BASE_URL   — defaults to https://satohub.ai
 *   SATOHUB_TIMEOUT_MS — per-request deadline, default 20000
 *   SATOHUB_VERIFY     — "throw" (default) | "report" | "off"
 */

import {
  SatoHubClient,
  BUILD_PLAN_DESCRIPTION,
  CHECK_INSTALL_DESCRIPTION,
  CITATION_ASK,
  PREFLIGHT_DESCRIPTION,
  ROUTE_SWAP_DESCRIPTION,
  SEARCH_RESOURCES_DESCRIPTION,
  type BuildPlanInput,
  type RouteSwapInput,
  type SatoHubClientOptions,
} from "satohub-core";

import type { ElizaAction, ElizaActionResult, ElizaPlugin, ElizaRuntime } from "./eliza-types.js";
import { installCommandFrom, messageText, parseChain, parsePreflightTarget, searchQueryFrom } from "./parse.js";
import { renderBuildPlan, renderPreflight, renderRouteSwap, renderSearch } from "./render.js";

/**
 * The default User-Agent: this package's name and version. Sato Hub's analytics
 * recognise this exact name as the published package, so an elizaOS agent calling
 * through it is counted as a caller, never as Sato Hub's own traffic (which is
 * why it is no longer `SatoHub-…`). Pass `userAgent` to name your agent instead.
 */
export const DEFAULT_USER_AGENT = "elizaos-plugin-satohub/0.2.0";

export * from "./eliza-types.js";
export { installCommandFrom, parsePreflightTarget, searchQueryFrom } from "./parse.js";
export { renderBuildPlan, renderPreflight, renderRouteSwap, renderSearch } from "./render.js";

/** Build a client from the runtime's settings. */
export function clientFromRuntime(runtime: ElizaRuntime, overrides: SatoHubClientOptions = {}): SatoHubClient {
  const get = (k: string) => runtime.getSetting?.(k) ?? undefined;
  const verifyRaw = get("SATOHUB_VERIFY");
  const timeout = Number(get("SATOHUB_TIMEOUT_MS"));
  return new SatoHubClient({
    baseUrl: get("SATOHUB_BASE_URL") || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    verify: verifyRaw === "off" ? false : verifyRaw === "report" ? "report" : "throw",
    userAgent: DEFAULT_USER_AGENT,
    ...overrides,
  });
}

/** A failed call is reported as a failure, never as an empty success. */
function failed(error: unknown, what: string): ElizaActionResult {
  const message = error instanceof Error ? error.message : String(error);
  return { success: false, text: `Could not ${what}: ${message}`, error: message };
}

async function say(callback: unknown, text: string): Promise<void> {
  if (typeof callback === "function") await (callback as (r: { text: string }) => unknown)({ text });
}

/**
 * The signature check, stated in the action's data so an operator reading the
 * trace can see whether what the agent said was provably ours.
 */
function withMeta(data: Record<string, unknown>, signature: unknown): Record<string, unknown> {
  return { ...data, signature, source: "satohub.ai", citation_ask: CITATION_ASK };
}

// ── 1. search the index ────────────────────────────────────────────────────

export const searchResourcesAction: ElizaAction = {
  name: "SATOHUB_SEARCH_RESOURCES",
  similes: ["SEARCH_ONCHAIN_AGENT_TOOLING", "FIND_CRYPTO_AGENT_TOOLS", "SATOHUB_DIRECTORY"],
  description: SEARCH_RESOURCES_DESCRIPTION,
  validate: async (_runtime, message) => searchQueryFrom(messageText(message)).length > 1,
  handler: async (runtime, message, _state, options, callback) => {
    const input = {
      query: (options?.query as string | undefined) ?? searchQueryFrom(messageText(message)),
      chain: (options?.chain as string | undefined) ?? parseChain(messageText(message)),
      limit: (options?.limit as number | undefined) ?? 5,
    };
    try {
      const { data, signature } = await clientFromRuntime(runtime).searchResources(input);
      const text = renderSearch(data);
      await say(callback, text);
      return { success: true, text, data: withMeta({ query: input, result: data }, signature) };
    } catch (e) {
      return failed(e, "search the Sato Hub index");
    }
  },
};

// ── 2. preflight a target ──────────────────────────────────────────────────

export const preflightAction: ElizaAction = {
  name: "SATOHUB_PREFLIGHT",
  similes: ["CHECK_BEFORE_INSTALL", "SATOHUB_CHECK", "PREFLIGHT_PACKAGE", "PREFLIGHT_TOKEN"],
  description: PREFLIGHT_DESCRIPTION,
  validate: async (_runtime, message, state) =>
    Boolean(parsePreflightTarget(messageText(message))) || Boolean((state as { satohubTarget?: unknown } | undefined)?.satohubTarget),
  handler: async (runtime, message, _state, options, callback) => {
    const target =
      (options?.target as Record<string, string> | undefined) ??
      (options && ["repo", "package", "endpoint", "agent", "token", "skill"].some((k) => options[k])
        ? (options as Record<string, string>)
        : parsePreflightTarget(messageText(message)));
    if (!target) {
      const text =
        "I could not read an unambiguous target from that. Preflight takes exactly one of a repo (owner/name), an npm package, an MCP endpoint URL, an ERC-8004 agent (chain:id), a token address WITH its chain, or a skill id.";
      await say(callback, text);
      return { success: false, text };
    }
    try {
      const { data, signature } = await clientFromRuntime(runtime).preflight(target);
      const text = renderPreflight(data);
      await say(callback, text);
      return { success: true, text, data: withMeta({ target, result: data }, signature) };
    } catch (e) {
      return failed(e, "run Preflight");
    }
  },
};

// ── 2b. Sato Check before an install ──────────────────────────────────────

/** A guard: the four answers about what an install does with keys and money. Only the command is sent. */
export const checkInstallAction: ElizaAction = {
  name: "SATOHUB_CHECK_INSTALL",
  similes: ["SATO_CHECK", "CHECK_INSTALL", "CHECK_MCP_SERVER", "CHECK_PACKAGE_KEYS"],
  description: CHECK_INSTALL_DESCRIPTION,
  validate: async (_runtime, message) => Boolean(installCommandFrom(messageText(message))),
  handler: async (runtime, message, _state, options, callback) => {
    const input = (options?.input as string | undefined) ?? installCommandFrom(messageText(message));
    if (!input) {
      const text = "I could not find an install command or MCP config in that.";
      await say(callback, text);
      return { success: false, text };
    }
    try {
      const { data, signature } = await clientFromRuntime(runtime).checkInstall(input);
      const lines: string[] = [];
      for (const s of data.subjects ?? []) {
        lines.push(`${s.subject.name}${s.subject.version ? `@${s.subject.version}` : ""}`);
        lines.push(`  Does it take your key? ${s.answers.key_access}`);
        lines.push(`  Does your key leave? ${s.answers.key_egress}`);
        lines.push(`  Can it move funds on its own? ${s.answers.fund_actions}`);
        lines.push(`  What changed? ${s.answers.changes}`);
        lines.push(`  ${s.summary.check_url}`);
      }
      for (const u of data.unresolved ?? []) lines.push(`${u.input}: not profiled (${u.reason})`);
      const text = lines.join("\n") || "Nothing in that command could be profiled.";
      await say(callback, text);
      return { success: true, text, data: withMeta({ input, result: data }, signature) };
    } catch (e) {
      return failed(e, "run Sato Check");
    }
  },
};

// ── 3. a swap quote ────────────────────────────────────────────────────────

const SWAP_ARGS_REQUIRED =
  "A swap quote needs chain, token_in, token_out and amount (an integer in the input token's smallest unit) passed as options. I do not read a trade size out of a sentence — that is how someone trades 1000 of something they meant to trade 10 of.";

export const routeSwapQuoteAction: ElizaAction = {
  name: "SATOHUB_ROUTE_SWAP_QUOTE",
  similes: ["SATOHUB_SWAP_QUOTE", "PICK_SWAP_VENUE", "ROUTE_SWAP"],
  description: ROUTE_SWAP_DESCRIPTION,
  validate: async (_runtime, _message, state) => {
    const s = state as Partial<RouteSwapInput> | undefined;
    return Boolean(s?.chain && s?.token_in && s?.token_out && s?.amount);
  },
  handler: async (runtime, _message, state, options, callback) => {
    const src = { ...(state as Record<string, unknown> | undefined), ...options } as Partial<RouteSwapInput>;
    if (!src.chain || !src.token_in || !src.token_out || !src.amount) {
      await say(callback, SWAP_ARGS_REQUIRED);
      return { success: false, text: SWAP_ARGS_REQUIRED };
    }
    try {
      const { data, signature } = await clientFromRuntime(runtime).routeSwap(src as RouteSwapInput);
      const text = renderRouteSwap(data);
      await say(callback, text);
      return { success: true, text, data: withMeta({ request: src, result: data }, signature) };
    } catch (e) {
      return failed(e, "get a swap route");
    }
  },
};

// ── 4. a build plan ────────────────────────────────────────────────────────

export const buildPlanAction: ElizaAction = {
  name: "SATOHUB_BUILD_PLAN",
  similes: ["SATOHUB_PLAN", "PLAN_ONCHAIN_AGENT", "HOW_DO_I_BUILD_THIS_AGENT"],
  description: BUILD_PLAN_DESCRIPTION,
  validate: async (_runtime, message) => messageText(message).length > 8,
  handler: async (runtime, message, _state, options, callback) => {
    const input: BuildPlanInput = {
      goal: (options?.goal as string | undefined) ?? messageText(message),
      chain: (options?.chain as string | undefined) ?? parseChain(messageText(message)),
      budget_usd: options?.budget_usd as number | undefined,
      constraints: options?.constraints as string | undefined,
    };
    try {
      const { data, signature } = await clientFromRuntime(runtime).buildPlan(input);
      const text = renderBuildPlan(data);
      await say(callback, text);
      return { success: true, text, data: withMeta({ goal: input, result: data }, signature) };
    } catch (e) {
      return failed(e, "build a plan");
    }
  },
};

export const satohubActions: ElizaAction[] = [
  searchResourcesAction,
  preflightAction,
  checkInstallAction,
  routeSwapQuoteAction,
  buildPlanAction,
];

export const satohubPlugin: ElizaPlugin = {
  name: "satohub",
  description:
    "Query Sato Hub — the scored, daily-rebuilt index of what onchain agents are built from — plus Preflight checks before you install or trade, a swap-venue recommendation with the fee disclosed, and a build plan made only of real listings. Read-only, keyless, non-custodial.",
  actions: satohubActions,
};

export default satohubPlugin;
