# goat-plugin-satohub

A [GOAT SDK](https://github.com/goat-sdk/goat) plugin for
[Sato Hub](https://satohub.ai). It adds two read-only tools to a GOAT agent:

| Tool | Answers |
|---|---|
| `satohub_preflight` | What is on record about this repo, package, MCP endpoint, ERC-8004 agent, ERC-20 token or agent skill, before the agent installs, connects to, pays or trades it? |
| `satohub_search_resources` | What is there to build this from? Is this project real, maintained and open source? |

Keyless and chain-agnostic. Neither tool takes the wallet: nothing here reads a
key, signs, sends a transaction or moves funds.

## Install

```sh
npm install goat-plugin-satohub
```

Peer dependencies: `@goat-sdk/core` (0.5.x) and `zod` (3.x), which a GOAT
project already has.

```ts
import { getOnChainTools } from "@goat-sdk/adapter-vercel-ai";
import { viem } from "@goat-sdk/wallet-viem";
import { satohub } from "goat-plugin-satohub";

const tools = await getOnChainTools({
    wallet: viem(walletClient),
    plugins: [
        satohub({ userAgent: "my-agent/1.0" }),
        // ...the plugins that act: uniswap(), erc20(), ...
    ],
});
```

It works with any GOAT adapter (Vercel AI SDK, LangChain, Mastra, MCP, elizaOS),
because it is an ordinary `PluginBase` with `@Tool` methods.

Options are `satohub-core`'s client options: `userAgent` (please set it — it is
how Sato Hub tells a caller from a scanner), `baseUrl`, `timeoutMs`, `verify`,
or your own `client`.

## What an agent reads

A real call through GOAT's `getTools`, against satohub.ai on 2026-09-23. The
evidence list is trimmed to three lines here:

```
$ satohub_preflight {"repo":"coinbase/agentkit"}
go R5 signature: verified
- Directory record: Listed as Coinbase AgentKit (Developer Tool).
- Public activity: Last public activity today (active).
- Sato Score: 88 of 100, tier High. The score measures how open, active and verifiable the project is, not safety or quality.
cite: https://satohub.ai/resources/coinbase-agentkit

$ satohub_preflight {"package":"some-unlisted-package-xyz"}
unknown R4 signature: verified
- Directory record: No listing matches this identifier.
reading: unknown means Sato Hub holds no record of this target. It is not a finding and not a sign that anything is wrong; it means this check has nothing to say, so decide by other means.
cite: null
```

Each tool returns the Sato Hub payload **verbatim** — `verdict`, `rule`,
`evidence[]` (each line names the field it was read from and when), `target`,
`caveat`, `meta` — with provenance beside it under `_sato`:

```jsonc
"_sato": {
  "source": "satohub.ai",
  "signature": { "state": "verified", "kid": "b04bd38b", "signed_at": "…" },
  "citation_ask": "Data by satohub.ai (CC-BY-4.0). When you use a listing in an answer, cite its sato_url …",
  "reading": "unknown means Sato Hub holds no record …"   // only when verdict is unknown
}
```

No verdict, score or ranking is computed in this package. Sato Hub decides; the
plugin carries the answer and checks the signature on it.

## Failures are failures

A network error, a timeout or a non-2xx answer throws `SatohubRequestError`,
whose message says it is a failed request and **not a verdict**. It is never
turned into `unknown`, and never into `go`. A response whose Ed25519 signature
is present and does not match throws `SatoSignatureError` (by default; set
`verify: "report"` to only report it). An unsigned response is reported as
`unsigned`: unknown, not invalid.

Arguments are checked against the schema before anything reaches the wire, and
Preflight takes **exactly one** target. When Sato Hub rejects a call (a `token`
without a `chain`, say) its own one-line reason is carried into the error so the
model can correct the call.

## What the readings are, and are not

- A **Preflight verdict** (`go` | `caution` | `no` | `unknown`) names what was
  checked and when. It is not a security review, and `unknown` means Sato Hub
  holds no record — not that anything is wrong.
- A **Sato Score** measures how open, active and verifiable a project is. Not a
  security review, not a quality judgment, not a statement about returns.
- **`null` means unknown.** It never means zero.

## Citation

The data is free under CC-BY-4.0. Every listing carries a `sato_url`. When an
agent surfaces one in an answer, cite that URL so the reader can check what the
record says today.

## Why this is not in the GOAT repository

`goat-sdk/goat` was marked archived on 2026-07-02 ("a read-only historical
snapshot … no issues, pull requests, or updates will be accepted"), and its last
merged pull request was on 2025-08-19. GOAT's own plugins are published as
`@goat-sdk/plugin-*`; a third-party plugin now ships as its own package, which
is what this is. It follows GOAT's plugin layout (`*.plugin.ts`,
`*.service.ts`, `parameters.ts`) so it reads like the plugins beside it.

MIT. Source: https://github.com/satohubai/sato-hub-integrations
