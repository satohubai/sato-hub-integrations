/**
 * goat-plugin-satohub — Sato Hub as a GOAT SDK plugin.
 *
 * Two read-only tools: `satohub_preflight` (what is on record about a repo,
 * package, MCP endpoint, ERC-8004 agent, ERC-20 token or agent skill before
 * your agent installs, connects to, pays or trades it) and
 * `satohub_search_resources` (the scored index of what onchain agents are
 * built from).
 *
 * Keyless. Nothing here reads the wallet, signs, sends or moves funds.
 */

export * from "./satohub.plugin.js";
export * from "./satohub.service.js";
export * from "./parameters.js";
export { SatoHubClient } from "satohub-core";
