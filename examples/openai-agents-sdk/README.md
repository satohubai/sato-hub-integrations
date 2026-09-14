# OpenAI Agents SDK — Sato Hub over hosted MCP

No package. The Agents SDK connects to remote MCP servers two ways; Sato Hub
serves both shapes from one endpoint, `https://satohub.ai/api/mcp`. Config only.

Keyless and read-only: no API key, no account, no header.

## Hosted MCP tool — OpenAI's servers call us

The model provider connects to the server; your process never opens the socket.

```ts
import { Agent, hostedMcpTool, run } from "@openai/agents";

const agent = new Agent({
  name: "Onchain builder",
  instructions:
    "Use Sato Hub for anything about onchain-agent tooling. Cite each listing's sato_url. " +
    "A Sato Score is not a safety rating and a Preflight 'unknown' means no record exists, not that something is wrong.",
  tools: [
    hostedMcpTool({
      serverLabel: "satohub",
      serverUrl: "https://satohub.ai/api/mcp",
      requireApproval: "never",
    }),
  ],
});

console.log((await run(agent, "What should I build a Base trading agent from?")).finalOutput);
```

`requireApproval` also takes a per-tool object — `{ never: { toolNames: [...] }, always: { toolNames: [...] } }` —
with an `onApproval` callback for the human in the loop.
([Agents SDK — MCP](https://openai.github.io/openai-agents-js/guides/mcp/))

Every Sato Hub tool is read-only and non-custodial, which is why `"never"` is
defensible here. If your policy is to approve anything that quotes a trade,
gate `onchain_agent_route_swap` and leave the reads open:

```ts
requireApproval: {
  always: { toolNames: ["onchain_agent_route_swap", "onchain_agent_route_launch"] },
  never: { toolNames: ["onchain_agent_search_resources", "onchain_agent_preflight", "onchain_agent_build_plan"] },
}
```

## Streamable HTTP — your process calls us

Use this when you want the traffic on your own network, or you are pointing at a
preview origin.

```ts
import { Agent, MCPServerStreamableHttp, run } from "@openai/agents";

const satohub = new MCPServerStreamableHttp({
  url: "https://satohub.ai/api/mcp",
  name: "Sato Hub",
});

const agent = new Agent({ name: "Onchain builder", mcpServers: [satohub] });

await satohub.connect();
try {
  console.log((await run(agent, "Preflight coinbase/agentkit before I install it.")).finalOutput);
} finally {
  await satohub.close();
}
```

## What the answers are, and are not

- A **Sato Score** measures how open, active and verifiable a project is. Not a
  security review, not a quality judgment, not a statement about returns.
- A **Preflight verdict** names what was checked and when. `unknown` means Sato
  Hub holds no record — not that anything is wrong.
- A **route** is a recommendation with the fee disclosed. A quote is not a fill,
  and nothing in the server signs, holds or moves funds.
- `null` means unknown. It never means zero.
- Every listing carries a `sato_url`. Cite it.
