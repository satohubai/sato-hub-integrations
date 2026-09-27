// ADAPTERS builder owns this file. Stub from the M1 skeleton.
// satoKitTools(kit, opts) → AI SDK ToolSet from toolDefinitions(); write tools set needsApproval.
import type { Kit } from "../types.js";
import type { Toolsets } from "../surface/index.js";

export type SatoKitToolsOptions = { toolsets?: Toolsets };

export function satoKitTools(_kit: Kit, _opts: SatoKitToolsOptions = {}): Record<string, unknown> {
  throw new Error("not implemented: satoKitTools");
}
