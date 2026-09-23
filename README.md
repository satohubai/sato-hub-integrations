# Sato Hub integrations

⬡ Sato Hub inside the agent frameworks people already run.

[Sato Hub](https://satohub.ai) indexes what onchain agents are built **from** —
agent frameworks, MCP servers, wallets and key management, x402 and stablecoin
payment rails, ERC-8004 identity, trading venues, onchain data, agent skills —
rebuilds the index daily from public evidence, and scores every listing on how
open, active and verifiable it is.

This repository packages four of those calls for four frameworks, so an agent
can reach them without anyone writing a fetch wrapper first.

| Package | Framework | Install |
|---|---|---|
| [`elizaos-plugin-satohub`](packages/elizaos-plugin-satohub) | elizaOS | `npm i elizaos-plugin-satohub` |
| [`satohub-ai-sdk-tools`](packages/satohub-ai-sdk-tools) | Vercel AI SDK | `npm i satohub-ai-sdk-tools` |
| [`satohub-langchain-tools`](packages/satohub-langchain-tools) | LangChain.js | `npm i satohub-langchain-tools` |
| [`satohub-core`](packages/satohub-core) | anything with `fetch` | `npm i satohub-core` |
| [`examples/claude-agent-sdk`](examples/claude-agent-sdk) | Claude Agent SDK | config only — no package |
| [`examples/openai-agents-sdk`](examples/openai-agents-sdk) | OpenAI Agents SDK | config only — no package |

Two of those rows are deliberately not packages. Both SDKs speak MCP, and Sato
Hub serves MCP; a package between them would be a wrapper around a URL.

## The four calls

| Call | What it answers |
|---|---|
| **search_resources** | What is there to build this from, and is this project real, maintained and open source? |
| **preflight** | Should I install / connect / pay / trade this — what is on record about it? |
| **route_swap** | Which venue would you route this swap to, on what readings, and what is the fee? |
| **build_plan** | Here is my goal in plain words — what is the stack, and what is the first action? |

All four are read-only. All 32 MCP tools are at
[`https://satohub.ai/mcp`](https://satohub.ai/mcp) if you want the rest.

## What these packages do, and do not

**They wrap. They never re-implement.** No scoring, ranking or verdict logic
lives in this repo. Sato Hub decides; these packages carry the answer and check
the signature on it.

**The payload comes back verbatim.** Every tool returns the record as Sato Hub
sent it, with provenance beside it and never folded into it — so nothing the
model reads has passed through a summariser of ours.

**Responses are verified.** Preflight verdicts and Sato Route decisions leave
satohub.ai with a detached Ed25519 signature. `satohub-core` fetches the JWKS,
verifies the raw bytes, and by default **throws** when a signature is present
and does not match. An **unsigned** response is reported as unsigned — unknown,
not invalid. We never emit a placeholder signature and this code never invents
one. ([the scheme](https://satohub.ai/.well-known/sato-signing.json))

**Non-custodial, everywhere.** Nothing here signs a transaction, holds a key,
deploys or moves funds. A swap tool returns a quote and calldata for the caller
to read and sign with its own signer. An unsigned route costs nothing. The Sato
fee — 3 bps stable-to-stable, 15 bps on any volatile leg — is stated in the
response before anything is signed, including when it is zero.

## The readings, and their limits

These are in every tool description, because a tool description is the part a
model actually reads:

- A **Sato Score** measures how open, active and verifiable a project is. It is
  **not** a security review, a quality judgment or a statement about returns.
- A **Preflight verdict** names **what was checked and when**. `unknown` means
  Sato Hub holds no record — not that something is wrong.
- A **route** is a **recommendation**, chosen by the fields named in
  `chosen_by`. A quote is not a fill.
- **`null` means unknown.** It never means zero.

## Citation

The data is free under CC-BY-4.0. Every record carries a `sato_url` — its
canonical page. When you surface a listing in an answer, cite that URL, so the
reader can check what the record says today rather than what it said when the
model read it.

## Development

Zero runtime dependencies beyond `satohub-core`; the frameworks are peer
dependencies, so nothing here drags a runtime into your tree.

```sh
npm install
npm test        # builds, then runs every package's tests against a mocked fetch
npm run typecheck
```

No test in this repo asserts a fact about a real listing. A test that pinned
today's Sato Score would fail tomorrow for the right reason, and teach everyone
to ignore it.

MIT.

## Install it in one line

```sh
claude mcp add --transport http satohub https://satohub.ai/api/mcp   # Claude Code
codex mcp add satohub --url https://satohub.ai/api/mcp               # Codex CLI
gemini mcp add --transport http satohub https://satohub.ai/api/mcp   # Gemini CLI
```

One click for [VS Code](https://vscode.dev/redirect/mcp/install?name=satohub&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fsatohub.ai%2Fapi%2Fmcp%22%7D)
or [VS Code Insiders](https://insiders.vscode.dev/redirect/mcp/install?name=satohub&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fsatohub.ai%2Fapi%2Fmcp%22%7D&quality=insiders).

**Cursor, Windsurf, Zed, Cline, Continue, JetBrains, LM Studio, Goose, Warp,
Claude Desktop** — deep links and the exact config block for each, generated
from one endpoint constant: **<https://satohub.ai/install>**
(machine-readable at [`/api/install.json`](https://satohub.ai/api/install.json)).
GitHub strips `cursor://` and `lmstudio://` links from READMEs, which is why the
one-click buttons live on that page rather than here.

Then drop in the [agent kit](https://satohub.ai/kit) — `AGENTS.md`,
`CLAUDE.md`, `.cursor/rules/satohub.mdc`, `.windsurfrules` — so the model
reaches for the server instead of answering from memory. Copies in
[`kit/`](./kit).

