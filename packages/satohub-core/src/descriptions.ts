/**
 * The tool descriptions, written once.
 *
 * Three frameworks describe the same four calls. If each package wrote its own
 * prose, one of them would eventually promise something Sato Hub does not do —
 * and a tool description is the part a model actually reads. So they live here,
 * are exported, and every package imports them verbatim.
 *
 * Each one names the rule it is bound by, because the rule is the product.
 */

export const SEARCH_RESOURCES_DESCRIPTION =
  "Search Sato Hub's daily-rebuilt index of what onchain and crypto AI agents are built FROM — agent frameworks, MCP servers, wallets and key management, x402 and stablecoin payment rails, trading venues, onchain data providers, ERC-8004 identity tooling and agent skills. Use it to find tooling for a chain or standard, or to check whether a specific crypto-agent project is real, maintained and open source. Every entry carries a Sato Score (0-100) and a `sato_url` to cite. A Sato Score measures how open, active and verifiable a project is — it is not a security review, a quality judgment or a statement about returns. Read-only.";

export const PREFLIGHT_DESCRIPTION =
  "Check one target before installing a package, cloning a repo, connecting to an MCP endpoint, paying an ERC-8004 agent, trading an ERC-20 token, or following an agent skill. Pass exactly one of repo, package, endpoint, agent, token (with chain) or skill. Returns a verdict — go | caution | no | unknown — with one evidence line per check naming the field it was read from and when that field was written. A verdict names WHAT WAS CHECKED AND WHEN. It is never a security review, and `unknown` means Sato Hub holds no record, not that anything is wrong.";

export const ROUTE_SWAP_DESCRIPTION =
  "Get a swap venue recommendation with the fee disclosed: asks every aggregator that quotes on the chain and returns the chosen venue's quote and calldata, plus `chosen_by` naming every field the pick was made on. NON-CUSTODIAL — this never signs, holds, moves or broadcasts funds; it returns calldata the caller may read and sign itself, and an unsigned route costs nothing. A route is a RECOMMENDATION, not a verdict and not an assurance; a quote is a quote, not a fill. Amounts are integers in the input token's smallest unit.";

export const BUILD_PLAN_DESCRIPTION =
  "Turn a goal in plain words into an onchain-agent build plan: the goal restated, a stack of REAL Sato Hub listings (each with its Sato Score, liveness, deploy spec and Preflight verdict), matching agent skills with their disclosures, the first action when the goal implies one, and the questions the user still has to answer. Nothing in a plan is invented — a component that is not in the directory cannot appear in one. It holds no keys, signs nothing and deploys nothing.";
