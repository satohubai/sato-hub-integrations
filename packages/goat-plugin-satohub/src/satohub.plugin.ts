import { type Chain, PluginBase } from "@goat-sdk/core";
import { SatoHubClient, type SatoHubClientOptions } from "satohub-core";
import { SatohubService } from "./satohub.service.js";

export type SatohubPluginOptions = SatoHubClientOptions & {
    /** Bring your own client (a shared one, a test double, a preview origin). */
    client?: SatoHubClient;
};

/**
 * The default User-Agent. It deliberately does not start with `SatoHub-`:
 * Sato Hub's logs treat that prefix as its own traffic, and a GOAT agent
 * calling this plugin is not. Pass `userAgent` to name your agent instead.
 */
export const DEFAULT_USER_AGENT = "goat-plugin-satohub/0.2.0";

export class SatohubPlugin extends PluginBase {
    constructor(options: SatohubPluginOptions = {}) {
        const { client, ...rest } = options;
        super("satohub", [new SatohubService(client ?? new SatoHubClient({ userAgent: DEFAULT_USER_AGENT, ...rest }))]);
    }

    /**
     * Chain-agnostic: Preflight and search are reads over Sato Hub's records,
     * not calls on the wallet's chain, so the plugin loads alongside any wallet.
     */
    supportsChain(_chain: Chain): boolean {
        return true;
    }
}

/**
 * Factory, in GOAT's convention:
 *
 * ```ts
 * const tools = await getOnChainTools({ wallet, plugins: [satohub()] });
 * ```
 */
export function satohub(options: SatohubPluginOptions = {}) {
    return new SatohubPlugin(options);
}
