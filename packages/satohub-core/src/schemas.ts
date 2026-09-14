/**
 * The four input schemas, written once and shared by the Vercel AI SDK package
 * and the LangChain package (which imports this file's twin). Zod is the one
 * thing both frameworks already require, so it is a peer dependency here rather
 * than a bundled copy — two zods in a process is a class of bug nobody enjoys.
 *
 * Every `.describe()` is the sentence the model reads. They are deliberately
 * about the FORM of the argument (an integer in the smallest unit, exactly one
 * target, `owner/name`), because that is what a model gets wrong; what the
 * answer means lives in the tool description.
 */

import { z } from "zod";

export const searchResourcesSchema = z.object({
  query: z.string().max(200).optional().describe("Free text, AND-matched across name, description and tags. e.g. 'wallet tooling', 'x402 payment rail'."),
  chain: z.string().max(40).optional().describe("Chain name as written in the index, e.g. 'Base', 'Solana', 'Ethereum'."),
  use_case: z
    .enum(["trading", "payments", "wallets", "data", "identity", "privacy", "launch", "security", "build"])
    .optional()
    .describe("What the tooling is FOR."),
  standard: z.string().max(40).optional().describe("A standard the listing implements, e.g. 'x402', 'erc-8004', 'mcp'. Implements, not merely works with."),
  iface: z.string().max(40).optional().describe("How you call it: 'mcp', 'sdk', 'rest-api', 'cli'."),
  sort: z.enum(["priority", "newest_release", "stars", "name"]).optional().describe("Default is priority."),
  limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
  offset: z.number().int().min(0).optional(),
});

export const preflightSchema = z.object({
  repo: z.string().max(200).optional().describe("A GitHub repository as 'owner/name' or its URL."),
  package: z.string().max(200).optional().describe("An npm or PyPI package name."),
  endpoint: z.string().max(300).optional().describe("An MCP endpoint URL. An unlisted endpoint gets one live handshake and can never come back 'go' — a handshake is not a record."),
  agent: z.string().max(60).optional().describe("An ERC-8004 agent as '<chain>:<id>', e.g. 'base:42'."),
  token: z.string().max(80).optional().describe("An ERC-20 contract address. Requires `chain`. EVM only."),
  chain: z.string().max(40).optional().describe("The chain for `token`. Required with it, ignored otherwise."),
  skill: z.string().max(200).optional().describe("An agent skill as '<registry>/<id>', registries clawhub, skills.sh or github."),
});

export const routeSwapSchema = z.object({
  chain: z.string().max(40).describe("The chain to swap on, e.g. 'Base', 'Solana'."),
  token_in: z.string().max(80).describe("Input token: a contract address, or a symbol the venue resolves."),
  token_out: z.string().max(80).describe("Output token. Must differ from token_in."),
  amount: z
    .string()
    .max(40)
    .describe("Amount of token_in as an INTEGER STRING in that token's smallest unit — 1 USDC (6 decimals) is '1000000'. Never a decimal figure."),
  slippage_bps: z.number().int().min(1).max(5000).optional().describe("Slippage tolerance in basis points."),
  taker: z.string().max(80).optional().describe("The address that would sign. Optional; nothing is signed here."),
});

export const buildPlanSchema = z.object({
  goal: z.string().min(3).max(500).describe("What the user wants to build, in their own words."),
  chain: z.string().max(40).optional().describe("Chain, if the user named one. Leave empty rather than assuming."),
  budget_usd: z.number().min(0).optional(),
  constraints: z.string().max(300).optional().describe("Anything that narrows the stack: a language, a runtime, 'no custodial keys'."),
});

export type SearchResourcesArgs = z.infer<typeof searchResourcesSchema>;
export type PreflightArgs = z.infer<typeof preflightSchema>;
export type RouteSwapArgs = z.infer<typeof routeSwapSchema>;
export type BuildPlanArgs = z.infer<typeof buildPlanSchema>;
