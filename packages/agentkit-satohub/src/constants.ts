/**
 * The default User-Agent. It deliberately does not start with `SatoHub-`:
 * Sato Hub's logs treat that prefix as its own traffic, and an AgentKit agent
 * calling this provider is not. Pass `userAgent` to name your agent instead.
 */
export const DEFAULT_USER_AGENT = "agentkit-satohub/0.2.1";

/** Where the Preflight rules are written down. */
export const PREFLIGHT_METHODOLOGY_URL = "https://satohub.ai/preflight/methodology";

/** Where the Sato Score rubric is written down. */
export const SCORE_METHODOLOGY_URL = "https://satohub.ai/sato-score";

/**
 * Chains the Preflight token lane reads today (EVM only). Any other chain is
 * refused by Sato Hub with its own list, which the provider passes on.
 */
export const TOKEN_CHAINS = ["Base", "Ethereum", "Arbitrum", "Robinhood Chain"] as const;

/** Maximum length of any single string copied from a response into tool output. */
export const MAX_TEXT_LENGTH = 500;

/** Default number of search results. */
export const DEFAULT_SEARCH_LIMIT = 5;

/**
 * What each Preflight verdict means, returned beside the verdict so the model
 * does not have to infer it. `unknown` above all: it is the absence of a
 * record, never a finding.
 */
export const VERDICT_MEANING = {
  go: "Sato Hub holds a record of this target and it meets every requirement of the rule named in `rule`. A verdict records what was checked and when; it is not a security review, an audit or a statement about returns.",
  caution:
    "Sato Hub holds a record of this target but it does not meet the bar for `go`. Read the evidence lines before proceeding; none of them is a security finding on its own.",
  no: "A check on record argues against proceeding (for example: the listing is retired, a probed endpoint did not answer, an ERC-8004 id is not registered, or no ERC-20 contract is at the address). The evidence line for the rule named in `rule` says which.",
  unknown:
    "Sato Hub holds no record of this target, or too few checks completed to decide. This is the absence of a record, not a finding against the target: treat it as neither a warning nor a pass, and decide by other means.",
} as const;

export type PreflightVerdict = keyof typeof VERDICT_MEANING;
