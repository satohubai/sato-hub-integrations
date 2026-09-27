// MCP builder owns this file. Stub from the M1 skeleton.
// createKitMcpServer builds an @modelcontextprotocol/sdk server whose tools are
// exactly toolDefinitions({ actions, toolsets }) with SERVER_INSTRUCTIONS.
// runStdio loads the kit with loadKitFromEnv and serves it over stdio (the only signer path).
import type { Kit } from "../types.js";
import type { Toolsets } from "../surface/index.js";
import type { LoadKitOptions } from "../config/index.js";

export type KitMcpServerOptions = { toolsets?: Toolsets };
export type RunStdioOptions = LoadKitOptions & KitMcpServerOptions;

export function createKitMcpServer(_kit: Kit, _opts: KitMcpServerOptions = {}): unknown {
  throw new Error("not implemented: createKitMcpServer");
}

export async function runStdio(_opts: RunStdioOptions): Promise<void> {
  throw new Error("not implemented: runStdio");
}
