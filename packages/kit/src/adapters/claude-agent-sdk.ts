// ADAPTERS builder owns this file. Stub from the M1 skeleton.
// createSatoKitSdkServer(kit) → createSdkMcpServer over toolDefinitions();
// requireApprovalHook() → a PreToolUse hook that asks for approval on tools
// whose _meta["anthropic/requiresUserInteraction"] is true.
import type { Kit } from "../types.js";

export function createSatoKitSdkServer(_kit: Kit): unknown {
  throw new Error("not implemented: createSatoKitSdkServer");
}

export function requireApprovalHook(): unknown {
  throw new Error("not implemented: requireApprovalHook");
}
