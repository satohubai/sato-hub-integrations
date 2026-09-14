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

No API key. No account.

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
