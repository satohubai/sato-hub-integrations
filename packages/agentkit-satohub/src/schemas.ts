/**
 * Action input schemas, in AgentKit's convention: every field is present and
 * optional ones are `.nullable()`, which is what OpenAI strict function calling
 * (the default in AgentKit's LangChain and Vercel AI SDK adapters) requires.
 *
 * Preflight takes `targetType` + `target` rather than six optional fields, so
 * "exactly one target" holds by construction instead of by a runtime check.
 */

import { z } from "zod";

export const PREFLIGHT_TARGET_TYPES = ["repo", "package", "endpoint", "agent", "token", "skill"] as const;

export const PreflightSchema = z
  .object({
    targetType: z
      .enum(PREFLIGHT_TARGET_TYPES)
      .describe(
        "What kind of target to check: 'repo' (GitHub repository), 'package' (npm or PyPI package), 'endpoint' (MCP server URL), 'agent' (ERC-8004 agent), 'token' (ERC-20 contract address) or 'skill' (agent skill).",
      ),
    target: z
      .string()
      .min(1)
      .max(300)
      .describe(
        "The target itself. repo: 'owner/name' or a GitHub URL, e.g. 'coinbase/agentkit'. package: a package name, e.g. '@coinbase/agentkit'. endpoint: an https MCP URL. agent: '<chain>:<id>', e.g. 'base:42'. token: a 0x contract address. skill: '<registry>/<id>' where registry is clawhub, skills.sh or github.",
      ),
    chain: z
      .string()
      .max(40)
      .nullable()
      .describe(
        "Required when targetType is 'token': one of 'Base', 'Ethereum', 'Arbitrum' or 'Robinhood Chain'. Ignored for every other target type; pass null.",
      ),
  })
  .strip()
  .describe("Check one target against Sato Hub's records before using it");

export const SearchResourcesSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(200)
      .describe("Free text matched against listing names, descriptions and tags, e.g. 'x402 payment rail' or 'wallet MCP server'."),
    chain: z
      .string()
      .max(40)
      .nullable()
      .describe("Only return listings that support this chain, e.g. 'Base' or 'Solana'. Pass null for any chain."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .nullable()
      .describe("How many results to return, 1 to 10. Pass null for the default of 5."),
  })
  .strip()
  .describe("Search Sato Hub's index of onchain agent tooling");

export type PreflightArgs = z.infer<typeof PreflightSchema>;
export type SearchResourcesArgs = z.infer<typeof SearchResourcesSchema>;
