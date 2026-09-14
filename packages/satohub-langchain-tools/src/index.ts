/**
 * satohub-langchain-tools — Sato Hub as four LangChain.js tools.
 *
 * ```ts
 * import { createAgent } from "langchain";
 * import { satohubTools } from "satohub-langchain-tools";
 *
 * const agent = createAgent({ model, tools: satohubTools() });
 * ```
 *
 * `tool()` is imported from `@langchain/core/tools`, which is where the helper
 * lives and what `langchain` re-exports — so this works on either import path
 * without pinning the umbrella package.
 *
 * Each tool returns the Sato Hub payload as a JSON string (LangChain tools are
 * string-returning by default), with the provenance block beside the payload,
 * never folded into it. No scoring, ranking or verdict logic lives here; the
 * Ed25519 signature is checked on the way through.
 *
 * NON-CUSTODIAL. Nothing here signs, holds or moves funds. `satohub_route_swap`
 * returns a quote and calldata for you to read and sign yourself.
 */

import { tool } from "@langchain/core/tools";
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

/**
 * The payload verbatim plus provenance, serialised. A tool that returned a
 * sentence of our prose instead of the record would be a summariser the caller
 * cannot audit.
 */
function envelope(res: SatoResponse<unknown>): string {
  const payload = res.data && typeof res.data === "object" && !Array.isArray(res.data) ? (res.data as Record<string, unknown>) : { result: res.data };
  return JSON.stringify({
    ...payload,
    _sato: { signature: res.signature, source: "satohub.ai", citation_ask: CITATION_ASK },
  });
}

function clientFrom(options: SatohubToolsOptions = {}): SatoHubClient {
  const { client, ...rest } = options;
  return client ?? new SatoHubClient({ userAgent: "SatoHub-langchain-tools", ...rest });
}

export function satohubSearchResourcesTool(options: SatohubToolsOptions = {}) {
  const client = clientFrom(options);
  return tool(async (args: SearchResourcesArgs) => envelope(await client.searchResources(args)), {
    name: "satohub_search_resources",
    description: SEARCH_RESOURCES_DESCRIPTION,
    schema: searchResourcesSchema,
  });
}

export function satohubPreflightTool(options: SatohubToolsOptions = {}) {
  const client = clientFrom(options);
  return tool(async (args: PreflightArgs) => envelope(await client.preflight(args)), {
    name: "satohub_preflight",
    description: PREFLIGHT_DESCRIPTION,
    schema: preflightSchema,
  });
}

export function satohubRouteSwapTool(options: SatohubToolsOptions = {}) {
  const client = clientFrom(options);
  return tool(async (args: RouteSwapArgs) => envelope(await client.routeSwap(args)), {
    name: "satohub_route_swap",
    description: ROUTE_SWAP_DESCRIPTION,
    schema: routeSwapSchema,
  });
}

export function satohubBuildPlanTool(options: SatohubToolsOptions = {}) {
  const client = clientFrom(options);
  return tool(async (args: BuildPlanArgs) => envelope(await client.buildPlan(args)), {
    name: "satohub_build_plan",
    description: BUILD_PLAN_DESCRIPTION,
    schema: buildPlanSchema,
  });
}

/**
 * All four, sharing one client (so one JWKS fetch, one connection pool). Pass
 * them straight to `createAgent({ tools })`.
 */
export function satohubTools(options: SatohubToolsOptions = {}) {
  const shared = { ...options, client: clientFrom(options) };
  return [
    satohubSearchResourcesTool(shared),
    satohubPreflightTool(shared),
    satohubRouteSwapTool(shared),
    satohubBuildPlanTool(shared),
  ];
}

export { SatoHubClient } from "satohub-core";
export default satohubTools;
