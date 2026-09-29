// ADAPTERS. satoKitActionProvider(kit, opts) → a @coinbase/agentkit
// ActionProvider exposing the same tools as every other door, generated from
// the one tool surface. It overrides getActions() instead of using the
// @CreateAction decorator, because the tool list is data, not methods.
//
// AgentKit has no native approval step. So:
//   - execute is REFUSED unless the provider was constructed with
//     { approve: async (summary) => boolean } and that callback returns true;
//   - other tools that need a person (prepare tools that would sign, pay or
//     broadcast) also go through `approve` when one is given.
// Each such action's description says it requires approval.
//
// Schemas: the surface's JSON Schemas turned into zod with the kit's zod
// (z.fromJSONSchema). AgentKit types its schema against zod 3; the object is a
// zod 4 schema, which the AI SDK / LangChain extensions accept.
import { ActionProvider } from "@coinbase/agentkit";
import type { Action, Network, WalletProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { approvalSummary, kitSurface, requiresApproval } from "./_dispatch.js";
import type { AdapterOptions, KitSurface, ToolEnvelope } from "./_dispatch.js";
import type { Kit } from "../types.js";

export type SatoKitApprove = (summary: string, call: { tool: string; args: unknown }) => Promise<boolean>;

export type SatoKitActionProviderOptions = AdapterOptions & { approve?: SatoKitApprove };

/** Networks this provider runs on (AgentKit network ids). */
export const SATO_KIT_AGENTKIT_NETWORKS = ["base-mainnet", "base-sepolia"] as const;
const CHAIN_IDS = new Set(["8453", "84532"]);

const APPROVAL_NOTE = " Requires a person's approval for each call: the provider asks its approve callback and refuses without one.";

export class SatoKitActionProvider extends ActionProvider<WalletProvider> {
  readonly surface: KitSurface;
  readonly #approve: SatoKitApprove | undefined;

  constructor(kit: Kit, opts: SatoKitActionProviderOptions = {}) {
    super("sato-kit", []);
    this.surface = kitSurface(kit, opts);
    this.#approve = opts.approve;
  }

  supportsNetwork(network: Network): boolean {
    if (network.protocolFamily !== "evm") return false;
    if (network.networkId && (SATO_KIT_AGENTKIT_NETWORKS as readonly string[]).includes(network.networkId)) return true;
    return !!network.chainId && CHAIN_IDS.has(String(network.chainId));
  }

  /** Runs one tool with the approval gate; returns the envelope. */
  async run(name: string, args: unknown): Promise<ToolEnvelope> {
    const def = this.surface.get(name);
    if (def && requiresApproval(def)) {
      if (!this.#approve) {
        if (def.kind === "execute") {
          return { ok: false, tool: name, error: { code: "approval_required", message: `${name} needs a person's approval; construct satoKitActionProvider(kit, { approve }) to allow it` } };
        }
      } else {
        const ok = await this.#approve(approvalSummary(def, args), { tool: name, args });
        if (!ok) return { ok: false, tool: name, error: { code: "approval_denied", message: `${name} was not approved` } };
      }
    }
    return this.surface.call(name, args);
  }

  override getActions(_walletProvider: WalletProvider): Action[] {
    return this.surface.defs.map((def) => ({
      name: def.name,
      description: requiresApproval(def) ? def.description + APPROVAL_NOTE : def.description,
      schema: z.fromJSONSchema(def.inputSchema as Parameters<typeof z.fromJSONSchema>[0]) as unknown as Action["schema"],
      invoke: async (args: unknown) => JSON.stringify(await this.run(def.name, args)),
    }));
  }
}

export function satoKitActionProvider(kit: Kit, opts: SatoKitActionProviderOptions = {}): SatoKitActionProvider {
  return new SatoKitActionProvider(kit, opts);
}
export * from "./agentkit-consume.js";
