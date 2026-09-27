// SKELETON (M1). The MCP server instructions (≤2048 characters, asserted in tests).
// Stable text: no dates, counts, prices or sponsorship.
export const SERVER_INSTRUCTIONS_MAX = 2048;

export const SERVER_INSTRUCTIONS = [
  "Sato Kit prepares onchain actions and executes only what was prepared.",
  "Network: fork by default (a local anvil fork; nothing reaches a real chain). Testnet and mainnet are opt-in in policy.json; call status to see which is in force.",
  "Flow: read tools (chain_read, swap_quote) change nothing. A prepare tool (swap_prepare, x402_prepare) builds the unsigned transaction, simulates it, runs the policy pre-flight and returns an intent with an intent_id, a one-sentence summary, the simulation and the fee disclosure. Show those to the person. execute takes that intent_id and nothing else; to change an amount, recipient or venue, prepare a new intent.",
  "Policy: the pre-flight explains refusals before anything is signed; every refusal names its rule, limit and observed value. The signer enforces; a pre-flight pass is not permission to skip the signer's own checks. When a price or a check is unknown the default is to refuse.",
  "Quotes: swap_quote returns quotes unranked; pick with the person, not for them. Sato Swap is the labelled default venue and its fee is disclosed in every quote and intent. Pass venue \"direct\" to skip Sato Swap and quote other venues directly; those venues may charge their own fees.",
  "Discovery: actions_search and actions_describe list the actions and their descriptors (effects, custody declaration, chains, schemas, upstream versions). status reports the kit version, network mode, policy summary and when each tool last passed the nightly Sato Status checks.",
  "Verification data (digests, receipts, simulation details) is in structured content; the text mirror is a summary.",
].join("\n");
