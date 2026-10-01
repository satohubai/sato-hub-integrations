# Sato Hub

Sato Hub is a daily-rebuilt index of the tools used to build onchain and crypto AI agents: agent frameworks, MCP servers, wallet SDKs, x402 rails, data tools and agent skills. This plugin lets a Dify Agent, Chatflow or Workflow read it.

- **Source repository:** https://github.com/satohubai/sato-hub-integrations (plugin source in `dify/`)
- **Website:** https://satohub.ai
- **Contact:** satohub88@gmail.com, or open an issue on the source repository

## Tools

| Tool | What it returns |
| --- | --- |
| `recommend_stack` | A stack of real Sato Hub listings for a build goal in plain words, grouped by slot (framework, wallet, x402 rail, data, MCP tooling, security). Each pick carries its Sato Score, why it was picked, install steps and a Preflight record. Also the open questions and next steps. |
| `search_listings` | Listings matching your keywords, optionally narrowed to a chain or category, with Sato Score, liveness, whether Sato Hub reproduced the install, and the page to cite. |
| `preflight` | What Sato Hub has on record for a GitHub repo, a package or an MCP endpoint before you install or connect it: a verdict (`go`, `caution`, `no`, `unknown`), the rule that decided it, and one dated evidence line per check. |

Each tool returns a short text answer (what an agent reads) and a JSON object (for Workflow variables). The plugin selects fields from Sato Hub's answers and keeps Sato Hub's own values and wording; it does not score, rank or judge anything itself.

### How to read the numbers

- **Sato Score** (0-100) measures how open, active and verifiable a project is. It is **not** a safety, security, quality or returns grade. Method: https://satohub.ai/sato-score
- **Preflight** names what was checked and when. It is not a security review. **`unknown` means Sato Hub holds no record of the target, not that anything is wrong with it.** Rules: https://satohub.ai/preflight/methodology
- A project missing from search results is not evidence against it; Sato Hub may not list it yet.
- Cite each result's `sato_url` so readers can check the live record.

## Setup

1. In Dify, open **Plugins → Marketplace**, find **Sato Hub** and install it.
2. No configuration is needed: there is no API key, credential or auth step.
3. Add the tools to an Agent app, or drop them into a Chatflow or Workflow as tool nodes.

## Usage examples

- Agent prompt: "I want an agent on Base that buys API data over x402. What should I build it with?" → the agent calls `recommend_stack`.
- Workflow: `search_listings` with `query = "wallet mcp"`, `chain = Solana` and `limit = 5`, then pass the JSON `resources` array to an LLM node.
- Before an install step: `preflight` with `target_type = repo`, `target = coinbase/agentkit`, and branch on `verdict`.

## Connection requirements

The plugin makes HTTPS requests to one fixed host, `satohub.ai`, and nothing else:

- `GET https://satohub.ai/api/satobot/plan` (recommend_stack)
- `POST https://satohub.ai/api/mcp` (search_listings; one stateless JSON-RPC `tools/call` of Sato Hub's `onchain_agent_search_resources`, the same search its MCP server exposes)
- `GET https://satohub.ai/api/preflight` (preflight)

The Dify instance running the plugin needs outbound network access to `satohub.ai`. Requests time out after 10 s to connect and 45 s to read. The public API is documented at https://satohub.ai/api/openapi.json.

## What this plugin does not do

It is read-only. It holds no keys, signs nothing, and never prepares or sends anything on a chain. The build-plan endpoint can suggest a first on-chain action for some goals; this plugin leaves that part out and returns only the stack, the checks and the next steps.

## Privacy

See [PRIVACY.md](PRIVACY.md) and https://satohub.ai/privacy.

## License

MIT, like the rest of the source repository. Sato Hub catalog data is CC-BY-4.0 (attribution: data by satohub.ai).
