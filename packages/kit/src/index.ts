export * from "./spec/index.js";
export * from "./version.js";
export type * from "./types.js";
export * from "./policy/index.js";
export * from "./signers/index.js";
export * from "./intent/index.js";
export * from "./receipts/index.js";
export * from "./actions/index.js";
export { createKit } from "./kit.js";
export type { KitOptions, SimulateTx } from "./kit.js";

// Named for discoverability (also reachable through the star exports above).
export { humanApprove, ApprovalRefusedError } from "./signers/index.js";
export { loadOrCreateIntentSecret, verifyIntentId } from "./intent/index.js";

// M1: the one tool surface, the shared config loader, and the doors built on them.
export * from "./surface/index.js";
export { loadKitFromEnv, rpcEnvName, KitConfigError, DEFAULT_FORK_RPC_URL, SATO_DIR, POLICY_FILE } from "./config/index.js";
export type { LoadKitOptions, LoadedKit } from "./config/index.js";
