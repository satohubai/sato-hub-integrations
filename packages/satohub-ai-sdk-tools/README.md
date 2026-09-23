# satohub-ai-sdk-tools

Four Vercel AI SDK tools for [Sato Hub](https://satohub.ai) — the scored,
daily-rebuilt index of what onchain agents are built from (frameworks, MCP
servers, wallets, x402 and stablecoin payment rails, ERC-8004 identity, trading
venues, agent skills). Search that index, check a target before installing or
trading, get a swap venue chosen on named readings with the fee disclosed, and
turn a goal in plain words into a build plan made only of listings that exist.
Read-only, keyless, non-custodial.

## Install

```sh
npm install satohub-ai-sdk-tools
```

Peer dependencies: `ai` (v5) and `zod`.

```ts
import { generateText } from "ai";
import { satohubTools } from "satohub-ai-sdk-tools";

const { text } = await generateText({
  model,
  tools: satohubTools(),
  prompt: "What should I build a Base trading agent from? Cite the sato_url for each pick.",
});
```

Take one, or mix them with your own:

```ts
const { satohub_preflight } = satohubTools();

await generateText({ model, tools: { satohub_preflight, ...myTools }, prompt });
```

Options are the client's — `baseUrl`, `timeoutMs`, `verify`, `userAgent`, or
your own `client` — passed straight through: `satohubTools({ verify: "report" })`.

No API key. No account. (Sato Hub needs none; your model provider still needs
its own.)

## One complete example: Preflight before installing

```ts
// preflight.ts — Node 20+.
// npm install satohub-ai-sdk-tools ai zod @ai-sdk/openai
// OPENAI_API_KEY=… npx tsx preflight.ts
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { satohubTools } from "satohub-ai-sdk-tools";

const { satohub_preflight } = satohubTools({ userAgent: "my-agent/1.0" });

const { text, steps } = await generateText({
  model: openai("gpt-5"),
  tools: { satohub_preflight },
  stopWhen: stepCountIs(3),
  prompt:
    "Before I install coinbase/agentkit, what does Sato Hub have on record? " +
    "Quote the verdict, the evidence, and cite the sato_url.",
});

console.log(text);
console.log(steps[0].toolResults[0].output);
```

The tool result the model reads — the Sato Hub payload verbatim, with the
provenance beside it and not folded into it:

```jsonc
{
  "verdict": "go",
  "rule": "R5",
  "target": {
    "kind": "repo",
    "value": "coinbase/agentkit",
    "slug": "coinbase-agentkit",
    "name": "Coinbase AgentKit",
    "sato_url": "https://satohub.ai/resources/coinbase-agentkit",
    "verify_url": "https://satohub.ai/verify/coinbase-agentkit"
  },
  "evidence": [
    { "check": "Directory record", "result": "Listed as Coinbase AgentKit (Developer Tool).",
      "source_field": "resources.slug", "checked_at": "2026-09-21" },
    { "check": "Sato Score", "result": "88 of 100, tier High. The score measures how open, active and verifiable the project is, not safety or quality.",
      "source_field": "resources.trust_score", "checked_at": "2026-09-21" }
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
`skipped` or `failed`. Everything above it is Sato Hub's own bytes.

## The tools

| Tool | Answers |
|---|---|
| `satohub_search_resources` | What is there to build this from? Is this project real, maintained and open source? |
| `satohub_preflight` | What is on record about this repo / package / MCP endpoint / ERC-8004 agent / token / skill? |
| `satohub_route_swap` | Which venue would Sato Hub route this swap to, on what readings, and what is the fee? |
| `satohub_build_plan` | Here is the goal — what is the stack, and what is the first action? |

Each returns the Sato Hub record **verbatim**, with the provenance beside it and
not folded into it:

```jsonc
{
  "verdict": "go",
  "rule": "R5",
  "evidence": [ … ],
  "_sato": {
    "signature": { "state": "verified", "kid": "b04bd38b", "signed_at": "…" },
    "source": "satohub.ai",
    "citation_ask": "Data by satohub.ai (CC-BY-4.0) …"
  }
}
```

Nothing the model reads has passed through a summariser of ours.

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
