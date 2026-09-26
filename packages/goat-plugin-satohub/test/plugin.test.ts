import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type Balance, type Chain, type Signature, type ToolBase, WalletClientBase, getTools } from "@goat-sdk/core";
import { type FetchLike, SatoHubClient, SatoSignatureError } from "satohub-core";

import { DEFAULT_USER_AGENT, SatohubPlugin, SatohubRequestError, UNKNOWN_READING, satohub } from "../src/index.js";

// ── doubles ────────────────────────────────────────────────────────────────

type Call = { method: string; url: string; headers: Record<string, string>; body?: string };

function mockFetch(respond: (url: string) => Response, log: Call[] = []): FetchLike {
    return async (url, init) => {
        log.push({
            method: init?.method ?? "GET",
            url,
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: typeof init?.body === "string" ? init.body : undefined,
        });
        return respond(url);
    };
}

function nth(log: Call[], i: number): Call {
    const call = log[i];
    assert.ok(call, `request #${i} was made`);
    return call;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const mcpFrame = (structuredContent: unknown) =>
    new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent } })}\n\n`,
        {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        },
    );

const BASE: Chain = { type: "evm", id: 8453, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } };
const SOLANA: Chain = { type: "solana", nativeCurrency: { name: "Solana", symbol: "SOL", decimals: 9 } };

/** A wallet that records any use. The plugin must never touch it. */
class RecordingWallet extends WalletClientBase {
    used: string[] = [];
    constructor(private readonly chain: Chain = BASE) {
        super();
    }
    getAddress(): string {
        this.used.push("getAddress");
        return "0x0000000000000000000000000000000000000001";
    }
    getChain(): Chain {
        return this.chain;
    }
    async signMessage(_message: string): Promise<Signature> {
        this.used.push("signMessage");
        throw new Error("the plugin must never sign");
    }
    async balanceOf(_address: string): Promise<Balance> {
        this.used.push("balanceOf");
        throw new Error("the plugin must never read balances");
    }
}

async function pluginTools(fetch: FetchLike, wallet = new RecordingWallet()) {
    const client = new SatoHubClient({ fetch, verify: false, userAgent: DEFAULT_USER_AGENT });
    const tools = await satohub({ client }).getTools(wallet);
    const byName = (name: string) => {
        const t = tools.find((x) => x.name === name);
        assert.ok(t, `tool ${name} is registered`);
        return t as ToolBase;
    };
    return { tools, byName, wallet };
}

const GO = {
    verdict: "go",
    rule: "R5",
    evidence: [
        { check: "Directory record", result: "Listed.", source_field: "resources.slug", checked_at: "2026-09-22" },
    ],
    target: { kind: "repo", value: "goat-sdk/goat", sato_url: "https://satohub.ai/resources/goat-sdk" },
    caveat: "A Preflight verdict names what was checked and when.",
};

const UNKNOWN = {
    verdict: "unknown",
    rule: "R4",
    evidence: [{ check: "Directory record", result: "No listing matches this identifier.", checked_at: null }],
    target: { kind: "package", value: "some-unlisted-package", sato_url: null },
};

// ── registration ───────────────────────────────────────────────────────────

test("GOAT reads exactly three tools off the decorators, in a stable order", async () => {
    const { tools } = await pluginTools(mockFetch(() => json({})));
    assert.deepEqual(
        tools.map((t) => t.name),
        ["satohub_preflight", "satohub_check_install", "satohub_search_resources"],
    );
});

test("it loads through GOAT's own getTools alongside the wallet's core tools", async () => {
    const wallet = new RecordingWallet(SOLANA);
    const client = new SatoHubClient({ fetch: mockFetch(() => json({})), verify: false });
    const tools = await getTools({ wallet, plugins: [satohub({ client })] });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("satohub_preflight"));
    assert.ok(names.includes("satohub_search_resources"));
    assert.deepEqual(wallet.used, []);
});

test("chain-agnostic: supports EVM, Solana and anything else", () => {
    const plugin = new SatohubPlugin({ client: new SatoHubClient({ fetch: mockFetch(() => json({})) }) });
    assert.equal(plugin.name, "satohub");
    assert.equal(plugin.supportsChain(BASE), true);
    assert.equal(plugin.supportsChain(SOLANA), true);
    assert.equal(plugin.supportsChain({ type: "aptos" }), true);
});

test("the descriptions carry the limits, not just the capability", async () => {
    const { byName } = await pluginTools(mockFetch(() => json({})));
    assert.match(byName("satohub_preflight").description, /never a security review/);
    assert.match(byName("satohub_preflight").description, /`unknown` means Sato Hub holds no record/);
    assert.match(byName("satohub_search_resources").description, /not a security review/);
});

// ── preflight ──────────────────────────────────────────────────────────────

test("preflight: one keyless GET to /api/preflight, with our User-Agent, payload verbatim", async () => {
    const log: Call[] = [];
    const { byName, wallet } = await pluginTools(mockFetch(() => json(GO), log));
    const out = (await byName("satohub_preflight").execute({ repo: "goat-sdk/goat" })) as Record<string, unknown>;

    assert.equal(log.length, 1);
    const call = nth(log, 0);
    assert.equal(call.method, "GET");
    const url = new URL(call.url);
    assert.equal(url.origin + url.pathname, "https://satohub.ai/api/preflight");
    assert.equal(url.searchParams.get("repo"), "goat-sdk/goat");
    assert.equal(call.headers["user-agent"], DEFAULT_USER_AGENT);
    assert.equal(call.headers.authorization, undefined);

    assert.equal(out.verdict, "go");
    assert.deepEqual(out.evidence, GO.evidence);
    assert.deepEqual(out.target, GO.target);
    const sato = out._sato as Record<string, unknown>;
    assert.equal(sato.source, "satohub.ai");
    assert.equal(sato.reading, undefined, "no unknown-reading on a real verdict");
    assert.deepEqual(wallet.used, []);
});

test("preflight: `unknown` comes back as unknown, with the reading beside it", async () => {
    const { byName } = await pluginTools(mockFetch(() => json(UNKNOWN)));
    const out = (await byName("satohub_preflight").execute({ package: "some-unlisted-package" })) as Record<
        string,
        unknown
    >;
    assert.equal(out.verdict, "unknown");
    assert.equal((out._sato as { reading?: string }).reading, UNKNOWN_READING);
    assert.match(UNKNOWN_READING, /not a finding/);
});

test("preflight: endpoint and token targets reach the wire as given", async () => {
    const log: Call[] = [];
    const { byName } = await pluginTools(mockFetch(() => json(UNKNOWN), log));
    await byName("satohub_preflight").execute({ endpoint: "https://example.com/mcp" });
    await byName("satohub_preflight").execute({ token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" });
    const a = new URL(nth(log, 0).url).searchParams;
    const b = new URL(nth(log, 1).url).searchParams;
    assert.equal(a.get("endpoint"), "https://example.com/mcp");
    assert.equal(b.get("token"), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    assert.equal(b.get("chain"), "base");
});

test("preflight: zero or two targets are refused before anything reaches the wire", async () => {
    const log: Call[] = [];
    const { byName } = await pluginTools(mockFetch(() => json(GO), log));
    await assert.rejects(async () => byName("satohub_preflight").execute({}), /exactly one/);
    await assert.rejects(async () => byName("satohub_preflight").execute({ repo: "a/b", package: "c" }), /exactly one/);
    assert.equal(log.length, 0);
});

test("preflight: a network failure is reported as a failure, never as unknown", async () => {
    const { byName } = await pluginTools(async () => {
        throw new TypeError("fetch failed");
    });
    await assert.rejects(
        async () => byName("satohub_preflight").execute({ repo: "goat-sdk/goat" }),
        (err: unknown) => {
            assert.ok(err instanceof SatohubRequestError);
            assert.match(err.message, /could not reach Sato Hub/);
            assert.match(err.message, /not a verdict/);
            return true;
        },
    );
});

test("preflight: a timeout is reported as a failure", async () => {
    const { byName } = await pluginTools(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await assert.rejects(
        async () => byName("satohub_preflight").execute({ repo: "goat-sdk/goat" }),
        SatohubRequestError,
    );
});

test("preflight: an HTTP error is reported as a failure with its status", async () => {
    const { byName } = await pluginTools(mockFetch(() => new Response("upstream down", { status: 503 })));
    await assert.rejects(
        async () => byName("satohub_preflight").execute({ repo: "goat-sdk/goat" }),
        (err: unknown) => {
            assert.ok(err instanceof SatohubRequestError);
            assert.match(err.message, /HTTP 503/);
            return true;
        },
    );
});

test("preflight: a 400 passes Sato Hub's own sentence on, so the call can be corrected", async () => {
    const { byName } = await pluginTools(
        mockFetch(() => json({ error: "?token= needs ?chain=. EVM only in v1.", chains: ["Base"] }, 400)),
    );
    await assert.rejects(
        async () => byName("satohub_preflight").execute({ token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }),
        (err: unknown) => {
            assert.ok(err instanceof SatohubRequestError);
            assert.match(err.message, /HTTP 400 \(\?token= needs \?chain=/);
            assert.match(err.message, /not a verdict/);
            return true;
        },
    );
});

test("preflight: a signature that does not match is rethrown, not swallowed", async () => {
    const fetch = mockFetch((url) =>
        url.includes("jwks")
            ? json({ keys: [] })
            : json(GO, 200, {
                  "Sato-Signature": "kid=deadbeef, alg=EdDSA, sig=AAAA",
                  "Sato-Signed-At": "2026-09-22T00:00:00Z",
              }),
    );
    const client = new SatoHubClient({ fetch }); // verify defaults to "throw"
    const [preflight] = await satohub({ client }).getTools(new RecordingWallet());
    assert.ok(preflight);
    await assert.rejects(async () => preflight.execute({ repo: "goat-sdk/goat" }), SatoSignatureError);
});

// ── search ─────────────────────────────────────────────────────────────────

test("search: one JSON-RPC tools/call to /api/mcp, payload verbatim", async () => {
    const log: Call[] = [];
    const page = { total: 1, resources: [{ slug: "goat-sdk", sato_url: "https://satohub.ai/resources/goat-sdk" }] };
    const { byName } = await pluginTools(mockFetch(() => mcpFrame(page), log));
    const out = (await byName("satohub_search_resources").execute({
        query: "wallet",
        chain: "Base",
        limit: 5,
    })) as Record<string, unknown>;

    assert.equal(log.length, 1);
    assert.equal(nth(log, 0).method, "POST");
    assert.equal(nth(log, 0).url, "https://satohub.ai/api/mcp");
    const rpc = JSON.parse(nth(log, 0).body ?? "{}") as {
        method: string;
        params: { name: string; arguments: Record<string, unknown> };
    };
    assert.equal(rpc.method, "tools/call");
    assert.equal(rpc.params.name, "onchain_agent_search_resources");
    assert.deepEqual(rpc.params.arguments, { query: "wallet", chain: "Base", limit: 5, response_format: "json" });

    assert.deepEqual(out.resources, page.resources);
    assert.equal((out._sato as { source: string }).source, "satohub.ai");
});

test("search: an out-of-range argument is refused before the wire", async () => {
    const log: Call[] = [];
    const { byName } = await pluginTools(mockFetch(() => mcpFrame({}), log));
    await assert.rejects(async () => byName("satohub_search_resources").execute({ limit: 500 }));
    assert.equal(log.length, 0);
});

test("search: a network failure is reported as a failure", async () => {
    const { byName } = await pluginTools(async () => {
        throw new TypeError("fetch failed");
    });
    await assert.rejects(
        async () => byName("satohub_search_resources").execute({ query: "x402" }),
        SatohubRequestError,
    );
});

test("check_install: one POST to /api/check/install with only the command; wallet untouched", async () => {
    const log: Call[] = [];
    const body = { schema: "sato.custody/v1", subjects: [], unresolved: [], has_observed_key_egress: false };
    const { byName, wallet } = await pluginTools(mockFetch(() => json(body), log));
    const out = (await byName("satohub_check_install").execute({ input: "uvx mcp-server-x" })) as Record<string, unknown>;
    assert.equal(log.length, 1);
    assert.equal(nth(log, 0).method, "POST");
    assert.equal(nth(log, 0).url, "https://satohub.ai/api/check/install");
    assert.deepEqual(JSON.parse(nth(log, 0).body ?? "{}"), { command: "uvx mcp-server-x" });
    assert.equal(out.has_observed_key_egress, false);
    assert.deepEqual(wallet.used, []);
});

test("the default user-agent is this package's name and version, never `SatoHub-…`", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(DEFAULT_USER_AGENT, `goat-plugin-satohub/${pkg.version}`, "bump DEFAULT_USER_AGENT with package.json");
  assert.doesNotMatch(DEFAULT_USER_AGENT, /^SatoHub-/);
});
