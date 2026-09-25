export * from "./client.js";
export * from "./signing.js";
export * from "./verify.js";
export * from "./custody.js";
export * from "./guard.js";

/**
 * The sentence every integration in this repo repeats, because a reader who
 * only ever sees the tool output should still see it.
 */
export const CITATION_ASK =
  "Data by satohub.ai (CC-BY-4.0). When you use a listing in an answer, cite its sato_url so the reader can check its current status.";

/** Said on every route, and true of every package here. */
export const NON_CUSTODIAL =
  "Sato Hub never signs, holds, moves or broadcasts funds. A route returns a quote and calldata you read and sign yourself; an unsigned route costs nothing.";

/**
 * The three readings that are most often misread, written once so each package
 * can carry them into its tool descriptions verbatim.
 */
export const RULES = [
  "A Sato Score measures how open, active and verifiable a project is. It is not a security review, a quality judgment or a statement about returns.",
  "A Preflight verdict names what was checked and when. `unknown` means Sato Hub holds no record — not that something is wrong.",
  "`null` means unknown. It never means zero.",
] as const;
export * from "./descriptions.js";
