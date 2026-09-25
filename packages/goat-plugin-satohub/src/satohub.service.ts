import { Tool } from "@goat-sdk/core";
import {
    CHECK_INSTALL_DESCRIPTION,
    CITATION_ASK,
    PREFLIGHT_DESCRIPTION,
    SEARCH_RESOURCES_DESCRIPTION,
    SatoHttpError,
    type SatoHubClient,
    type SatoResponse,
    SatoSignatureError,
} from "satohub-core";
import { CheckInstallParameters, PreflightParameters, SearchResourcesParameters } from "./parameters.js";

/**
 * Said beside every `unknown` verdict, because it is the reading most often
 * mistaken for a warning.
 */
export const UNKNOWN_READING =
    "unknown means Sato Hub holds no record of this target. It is not a finding and not a sign that anything is wrong; it means this check has nothing to say, so decide by other means.";

/** Thrown when Sato Hub could not be reached or answered with an error. */
export class SatohubRequestError extends Error {
    constructor(tool: string, reason: string, options?: { cause?: unknown }) {
        super(
            `${tool} failed: ${reason}. This is a failed request, not a verdict — do not treat it as 'unknown' or as 'go'.`,
            options,
        );
        this.name = "SatohubRequestError";
    }
}

/**
 * The two tools. Each returns the Sato Hub payload verbatim, with provenance
 * beside it under `_sato` and never folded into it. No verdict, score or
 * ranking is computed here.
 *
 * Neither tool takes the wallet client: nothing here reads a key, signs,
 * sends a transaction or moves funds.
 */
export class SatohubService {
    constructor(private readonly client: SatoHubClient) {}

    @Tool({
        name: "satohub_preflight",
        description: PREFLIGHT_DESCRIPTION,
    })
    async preflight(parameters: PreflightParameters) {
        const input = PreflightParameters.schema.parse(parameters);
        const res = await this.call("satohub_preflight", () => this.client.preflight(input));
        const verdict = (res.data as { verdict?: unknown } | null)?.verdict;
        return envelope(res, verdict === "unknown" ? UNKNOWN_READING : undefined);
    }

    /** Sato Check guard: call before adding a crypto package, MCP server or skill. */
    @Tool({
        name: "satohub_check_install",
        description: CHECK_INSTALL_DESCRIPTION,
    })
    async checkInstall(parameters: CheckInstallParameters) {
        const { input } = CheckInstallParameters.schema.parse(parameters);
        return envelope(await this.call("satohub_check_install", () => this.client.checkInstall(input)));
    }

    @Tool({
        name: "satohub_search_resources",
        description: SEARCH_RESOURCES_DESCRIPTION,
    })
    async searchResources(parameters: SearchResourcesParameters) {
        const input = SearchResourcesParameters.schema.parse(parameters);
        return envelope(await this.call("satohub_search_resources", () => this.client.searchResources(input)));
    }

    /**
     * Network, timeout and HTTP failures become a SatohubRequestError that says
     * plainly it is not a verdict. A bad signature and a bad argument are
     * rethrown unchanged: both already say exactly what went wrong.
     */
    private async call(tool: string, fn: () => Promise<SatoResponse<unknown>>): Promise<SatoResponse<unknown>> {
        try {
            return await fn();
        } catch (err) {
            if (err instanceof SatoSignatureError) throw err;
            if (err instanceof SatoHttpError) {
                const said = serverError(err.body);
                const reason = `Sato Hub answered HTTP ${err.status}${said ? ` (${said})` : ""}`;
                throw new SatohubRequestError(tool, reason, { cause: err });
            }
            if (isTransportError(err)) {
                const reason = err instanceof Error ? err.message : String(err);
                throw new SatohubRequestError(tool, `could not reach Sato Hub (${reason})`, { cause: err });
            }
            throw err;
        }
    }
}

function envelope(res: SatoResponse<unknown>, reading?: string) {
    const payload =
        res.data && typeof res.data === "object" && !Array.isArray(res.data)
            ? (res.data as Record<string, unknown>)
            : { result: res.data };
    return {
        ...payload,
        _sato: {
            source: "satohub.ai",
            signature: res.signature,
            citation_ask: CITATION_ASK,
            ...(reading ? { reading } : {}),
        },
    };
}

/**
 * A 4xx from Sato Hub carries `{ "error": "..." }` saying what to fix — e.g.
 * "?token= needs ?chain=". Pass that sentence on, so the model can correct the
 * call; anything else in the body stays out of the message.
 */
function serverError(body: string): string | undefined {
    try {
        const said = (JSON.parse(body) as { error?: unknown }).error;
        return typeof said === "string" ? said.slice(0, 300) : undefined;
    } catch {
        return undefined;
    }
}

/** fetch rejects with a TypeError; a timeout aborts with a DOMException. */
function isTransportError(err: unknown): boolean {
    if (err instanceof TypeError) return true;
    const name = (err as { name?: unknown } | null)?.name;
    return name === "AbortError" || name === "TimeoutError";
}
