/**
 * agentkit-satohub — Sato Hub as a Coinbase AgentKit action provider.
 *
 * Two read-only actions: `preflight` (what is on record about a repo, package,
 * MCP endpoint, ERC-8004 agent, ERC-20 token or agent skill before your agent
 * installs, connects to, pays or trades it) and `search_resources` (the scored
 * index of what onchain agents are built from).
 *
 * Keyless. Nothing here reads the wallet, signs, sends or moves funds.
 */

export * from "./satohubActionProvider.js";
export * from "./schemas.js";
export {
  DEFAULT_USER_AGENT,
  PREFLIGHT_METHODOLOGY_URL,
  SCORE_METHODOLOGY_URL,
  TOKEN_CHAINS,
  VERDICT_MEANING,
  type PreflightVerdict,
} from "./constants.js";
export { SatoHubClient } from "satohub-core";
