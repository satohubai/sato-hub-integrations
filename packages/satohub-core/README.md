# satohub-core

A thin, zero-dependency client for the public [Sato Hub](https://satohub.ai)
surfaces — the scored, daily-rebuilt index of what onchain agents are built
from, Preflight, Sato Route and the Sato Bot build plan — with the Ed25519
response-signature verifier included. The framework packages in this repo are
built on it; use it directly when you are wiring something else.

## Install

```sh
npm install satohub-core
```

No runtime dependencies. Node 20+ (it uses `fetch`, `AbortSignal.timeout` and
`node:crypto`). No API key, no account.

```ts
import { SatoHubClient } from "satohub-core";

const sato = new SatoHubClient({ userAgent: "my-agent/1.0" });

const { data, signature } = await sato.preflight({ repo: "coinbase/agentkit" });
console.log(data.verdict, signature.state); // "go" "verified"

await sato.searchResources({ query: "x402 payment rail", chain: "Base", limit: 5 });
await sato.routeSwap({ chain: "Base", token_in: "USDC", token_out: "WETH", amount: "1000000" });
await sato.buildPlan({ goal: "a Base trading agent that swaps USDC to ETH on a signal" });
```

Please set `userAgent`. It is the only thing that distinguishes a caller from a
scanner.

## Which wire, and why

`searchResources` goes to `POST /api/mcp` (JSON-RPC over Streamable HTTP),
because the free-text search lives on the MCP surface; the bulk export is a
filtered mirror of the catalogue, not a search, so using it would quietly change
the question being asked. The other three go to their REST routes, which are the
documented public API and are signed.

## Signatures

```ts
type SignatureCheck =
  | { state: "verified"; kid: string; signed_at: string }
  | { state: "unsigned"; reason: string }   // unknown, not invalid
  | { state: "skipped";  reason: string }   // verify: false, or no JWKS reachable
  | { state: "failed";   reason: string };  // only reachable under verify: "report"
```

Default is `verify: "throw"` — a signature that is present and does not match
throws `SatoSignatureError`, because a claim that cannot be shown to be ours
should not be returned as fact. `"report"` downgrades that to `state: "failed"`.
`false` skips the JWKS fetch entirely.

An **unsigned** response never throws under any setting. Sato Hub emits
`meta.signature: null` and no header when a deployment has no signing key; that
is unknown, not invalid, and we never emit a placeholder signature.

The verifier is also exported on its own — pure, fetching nothing:

```ts
import { verifyResponseSignature, verifyBodySignature } from "satohub-core";
```

Verify the **bytes as received**, never a re-serialised object: one added space
and the header signature fails, which is the point.
[The scheme.](https://satohub.ai/.well-known/sato-signing.json)

## Schemas (optional)

`satohub-core/schemas` exports the four Zod schemas the framework packages use.
The main entry point does not import Zod, so it stays dependency-free; Zod is an
**optional peer** needed only for that subpath.

```ts
import { preflightSchema } from "satohub-core/schemas";
```

## Non-custodial

Nothing here signs a transaction, holds a key, deploys or moves funds.
`routeSwap` returns a quote and calldata for you to read and sign yourself; a
route that is never signed costs nothing.

## What the readings are, and are not

- A **Sato Score** measures how open, active and verifiable a project is. Not a
  security review, not a quality judgment, not a statement about returns.
- A **Preflight verdict** names what was checked and when. `unknown` means Sato
  Hub holds no record — not that anything is wrong.
- A **route** is a recommendation. A quote is not a fill.
- **`null` means unknown.** It never means zero.

Data is CC-BY-4.0. Every listing carries a `sato_url`; cite it.

MIT. Source: https://github.com/satohubai/sato-hub-integrations
