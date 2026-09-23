# satohub-langchain-tools

Four LangChain.js tools for [Sato Hub](https://satohub.ai) — the scored,
daily-rebuilt index of what onchain agents are built from (frameworks, MCP
servers, wallets, x402 and stablecoin payment rails, ERC-8004 identity, trading
venues, agent skills). Search that index, check a target before installing or
trading, get a swap venue chosen on named readings with the fee disclosed, and
turn a goal in plain words into a build plan made only of listings that exist.
Read-only, keyless, non-custodial.

## Install

```sh
npm install satohub-langchain-tools
```

Peer dependencies: `@langchain/core` and `zod`.

```ts
import { createAgent } from "langchain";
import { satohubTools } from "satohub-langchain-tools";

const agent = createAgent({
  model: "openai:gpt-5",
  tools: satohubTools(),
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "What should I build a Base trading agent from?" }],
});
```

Or take them one at a time:

```ts
import { satohubPreflightTool, satohubSearchResourcesTool } from "satohub-langchain-tools";

const tools = [satohubSearchResourcesTool(), satohubPreflightTool(), ...myTools];
```

`satohubTools()` builds **one** client and shares it across the four, so the
JWKS is fetched once for the set. Options are the client's — `baseUrl`,
`timeoutMs`, `verify`, `userAgent`, or your own `client`.

No API key. No account. (Sato Hub needs none; your model provider still needs
its own.)

## One complete example: Preflight before installing

Call the tool directly — no model, no agent loop — to see exactly what an agent
would read:

```ts
// preflight.ts — Node 20+.
// npm install satohub-langchain-tools @langchain/core zod
// npx tsx preflight.ts
import { satohubPreflightTool } from "satohub-langchain-tools";

const preflight = satohubPreflightTool({ userAgent: "my-agent/1.0" });

// LangChain tools return a string; this one is JSON.
const raw = await preflight.invoke({ repo: "coinbase/agentkit" });
const report = JSON.parse(raw);

console.log(report.verdict, report.rule, report._sato.signature.state);
for (const e of report.evidence) console.log(`- ${e.check}: ${e.result}`);
console.log("cite:", report.target.sato_url);
```

Printed:

```
go R5 verified
- Directory record: Listed as Coinbase AgentKit (Developer Tool).
- Public activity: Last public activity 4d ago (active).
- Sato Score: 88 of 100, tier High. The score measures how open, active and verifiable the project is, not safety or quality.
cite: https://satohub.ai/resources/coinbase-agentkit
```

The parsed string is the Sato Hub payload verbatim, with the provenance beside
it:

```jsonc
{
  "verdict": "go",
  "rule": "R5",
  "target": {
    "kind": "repo", "value": "coinbase/agentkit", "slug": "coinbase-agentkit",
    "name": "Coinbase AgentKit",
    "sato_url": "https://satohub.ai/resources/coinbase-agentkit",
    "verify_url": "https://satohub.ai/verify/coinbase-agentkit"
  },
  "evidence": [
    { "check": "Directory record", "result": "Listed as Coinbase AgentKit (Developer Tool).",
      "source_field": "resources.slug", "checked_at": "2026-09-21" }
  ],
  "checked_at": "2026-09-22T02:00:52.098Z",
  "caveat": "A Preflight verdict names what was checked and when … Unknown means we hold no record — not that anything is wrong.",
  "meta": { "rules": [ … ], "coverage": { … }, "next_update": { … }, "signature": { "alg": "EdDSA", "kid": "b04bd38b", … } },
  "_sato": {
    "signature": { "state": "verified", "kid": "b04bd38b", "signed_at": "2026-09-22T02:00:52.118Z" },
    "source": "satohub.ai",
    "citation_ask": "Data by satohub.ai (CC-BY-4.0). When you use a listing in an answer, cite its sato_url so the reader can check its current status."
  }
}
```

`_sato.signature.state` is `verified`, `unsigned` (unknown, not invalid),
`skipped` or `failed`. The other three tools return the same envelope around
their own payload.

## The tools

| Tool | Answers |
|---|---|
| `satohub_search_resources` | What is there to build this from? Is this project real, maintained and open source? |
| `satohub_preflight` | What is on record about this repo / package / MCP endpoint / ERC-8004 agent / token / skill? |
| `satohub_route_swap` | Which venue would Sato Hub route this swap to, on what readings, and what is the fee? |
| `satohub_build_plan` | Here is the goal — what is the stack, and what is the first action? |

Each returns the Sato Hub record as a JSON string, **verbatim**, with the
provenance beside it under `_sato` — the signature state, the source, and the
citation ask. Nothing the model reads has passed through a summariser of ours.

## Non-custodial

`satohub_route_swap` never signs, holds, moves or broadcasts funds. It returns a
quote and calldata for you to read and sign yourself; a route that is never
signed costs nothing. The Sato fee — 3 bps stable-to-stable, 15 bps on any
volatile leg — is in the response before anything is signed, including when it
is zero. `amount` is an **integer string in the input token's smallest unit**,
which the schema enforces so a decimal figure never reaches the wire.

## Signed responses

Preflight verdicts and Sato Route decisions carry a detached Ed25519 signature
over the exact bytes. This package verifies it and by default **throws** when a
signature is present and does not match. An unsigned response is reported as
unsigned: **unknown, not invalid**.
[The scheme.](https://satohub.ai/.well-known/sato-signing.json)

## What the readings are, and are not

- A **Sato Score** measures how open, active and verifiable a project is. Not a
  security review, not a quality judgment, not a statement about returns.
- A **Preflight verdict** names what was checked and when. `unknown` means Sato
  Hub holds no record — not that anything is wrong.
- A **route** is a recommendation, chosen by the fields named in `chosen_by`. A
  quote is not a fill.
- **`null` means unknown.** It never means zero.

## Citation

The data is free under CC-BY-4.0. Every listing carries a `sato_url` — its
canonical page. When you surface one in an answer, cite that URL so the reader
can check what the record says today.

MIT. Source: https://github.com/satohubai/sato-hub-integrations
