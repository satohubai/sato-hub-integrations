/**
 * satohub-ai-sdk-tools — Sato Hub as four Vercel AI SDK tools.
 *
 * ```ts
 * import { generateText } from "ai";
 * import { satohubTools } from "satohub-ai-sdk-tools";
 *
 * const { text } = await generateText({
 *   model,
 *   tools: satohubTools(),
 *   prompt: "What should I build a Base trading agent from?",
 * });
 * ```
 *
 * Each tool is a `description`, an `inputSchema` and an `execute` that calls
 * satohub.ai and hands the answer back unchanged. No scoring, ranking or
 * verdict logic lives here — and the Ed25519 signature on every signed response
 * is checked on the way through, so a tampered body fails the call instead of
 * being returned as fact.
 *
 * WHAT COMES BACK. `{ ...payload, _sato: { signature, source, citation_ask } }`.
 * The payload is verbatim, so nothing the model reads has passed through a
 * summariser of ours. `_sato.signature.state` is one of `verified`, `unsigned`
 * (unknown, not invalid), `skipped` or `failed`.
 *
 * NON-CUSTODIAL. Nothing here signs, holds or moves funds. `satohub_route_swap`
 * returns a quote and calldata for you to read and sign yourself.
 */

import { tool, type Tool } from "ai";
import {
  SatoHubClient,
  BUILD_PLAN_DESCRIPTION,
  CITATION_ASK,
  PREFLIGHT_DESCRIPTION,
  ROUTE_SWAP_DESCRIPTION,
  SEARCH_RESOURCES_DESCRIPTION,
  type SatoHubClientOptions,
  type SatoResponse,
} from "satohub-core";
import {
  buildPlanSchema,
  preflightSchema,
  routeSwapSchema,
  searchResourcesSchema,
  type BuildPlanArgs,
  type PreflightArgs,
  type RouteSwapArgs,
  type SearchResourcesArgs,
} from "satohub-core/schemas";

export type SatohubToolsOptions = SatoHubClientOptions & {
  /** Bring your own client (a shared one, a test double, a preview origin). */
  client?: SatoHubClient;
};

/** The envelope every tool returns: the payload verbatim, plus the provenance. */
function envelope(res: SatoResponse<unknown>): Record<string, unknown> {
  const payload = res.data && typeof res.data === "object" && !Array.isArray(res.data) ? (res.data as Record<string, unknown>) : { result: res.data };
  return {
    ...payload,
    _sato: {
      signature: res.signature,
      source: "satohub.ai",
      citation_ask: CITATION_ASK,
    },
  };
}

function clientFrom(options: SatohubToolsOptions = {}): SatoHubClient {
  const { client, ...rest } = options;
  return client ?? new SatoHubClient({ userAgent: "SatoHub-ai-sdk-tools", ...rest });
}

/**
 * The four tools, keyed by the names the model will see. Spread into `tools:`,
 * or pick the ones you want: `const { satohub_preflight } = satohubTools()`.
 */
export function satohubTools(options: SatohubToolsOptions = {}): {
  satohub_search_resources: Tool<SearchResourcesArgs, Record<string, unknown>>;
  satohub_preflight: Tool<PreflightArgs, Record<string, unknown>>;
  satohub_route_swap: Tool<RouteSwapArgs, Record<string, unknown>>;
  satohub_build_plan: Tool<BuildPlanArgs, Record<string, unknown>>;
} {
  const client = clientFrom(options);

  return {
    satohub_search_resources: tool({
      description: SEARCH_RESOURCES_DESCRIPTION,
      inputSchema: searchResourcesSchema,
      execute: async (args) => envelope(await client.searchResources(args)),
    }),

    satohub_preflight: tool({
      description: PREFLIGHT_DESCRIPTION,
      inputSchema: preflightSchema,
      execute: async (args) => envelope(await client.preflight(args)),
    }),

    satohub_route_swap: tool({
      description: ROUTE_SWAP_DESCRIPTION,
      inputSchema: routeSwapSchema,
      execute: async (args) => envelope(await client.routeSwap(args)),
    }),

    satohub_build_plan: tool({
      description: BUILD_PLAN_DESCRIPTION,
      inputSchema: buildPlanSchema,
      execute: async (args) => envelope(await client.buildPlan(args)),
    }),
  };
}

export { SatoHubClient } from "satohub-core";
export default satohubTools;
