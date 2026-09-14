# Claude Agent SDK — Sato Hub over hosted MCP

No package. The Agent SDK speaks MCP, Sato Hub serves MCP over Streamable HTTP
at `https://satohub.ai/api/mcp`, and there is nothing in between worth
publishing. Config only.

Keyless and read-only: no API key, no account, no header.

## In code

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "What should I build a Base trading agent from? Cite the sato_url for each pick.",
  options: {
    mcpServers: {
      satohub: { type: "http", url: "https://satohub.ai/api/mcp" },
    },
    allowedTools: ["mcp__satohub__*"],
  },
})) {
  if (message.type === "result" && message.subtype === "success") console.log(message.result);
}
```

MCP tools require explicit permission: without `allowedTools`, Claude sees the
tools and cannot call them. The naming pattern is `mcp__<server>__<tool>`, so
`mcp__satohub__onchain_agent_preflight` grants exactly Preflight and nothing
else. ([Agent SDK — MCP](https://code.claude.com/docs/en/agent-sdk/mcp))

## From a config file

`.mcp.json` at the project root, picked up when the `project` setting source is
enabled (it is, for default `query()` options):

```json
{
  "mcpServers": {
    "satohub": {
      "type": "http",
      "url": "https://satohub.ai/api/mcp"
    }
  }
}
```

The same file works in Claude Code. Or install the plugin, which brings the
server and the Sato Hub skill together:

```
/plugin marketplace add satohubai/sato-plugins
/plugin install sato-hub@sato-plugins
```

## Narrowing the grant

The server is read-only, but least privilege still reads better in a review:

```ts
allowedTools: [
  "mcp__satohub__onchain_agent_search_resources",
  "mcp__satohub__onchain_agent_preflight",
  "mcp__satohub__onchain_agent_build_plan",
]
```

## What the answers are, and are not

- A **Sato Score** measures how open, active and verifiable a project is. Not a
  security review, not a quality judgment, not a statement about returns.
- A **Preflight verdict** names what was checked and when. `unknown` means Sato
  Hub holds no record — not that anything is wrong.
- A **route** is a recommendation with the fee disclosed. A quote is not a fill,
  and nothing in the server signs, holds or moves funds.
- `null` means unknown. It never means zero.
- Every listing carries a `sato_url`. Cite it, so the reader can check what the
  record says today rather than what it said when the model read it.
