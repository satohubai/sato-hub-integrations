# agentkit-satohub

A [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider for
[Sato Hub](https://satohub.ai). It adds two read-only actions to an AgentKit
agent:

| Action | Answers |
|---|---|
| `SatohubActionProvider_preflight` | What is on record about this repo, package, MCP endpoint, ERC-8004 agent, ERC-20 token or agent skill, before the agent installs, connects to, pays or trades it? |
| `SatohubActionProvider_search_resources` | What is there to build this from? Is this project real, maintained and open source? |

Keyless and network-agnostic. Neither action takes the wallet provider: nothing
here reads a key, signs, approves, pays or broadcasts.

## Install

```sh
npm install agentkit-satohub
```

Peer dependencies: `@coinbase/agentkit` (0.10.x) and `zod` (3.x), which an
AgentKit project already has.

## Example

```ts
import { AgentKit } from "@coinbase/agentkit";
import { satohubActionProvider } from "agentkit-satohub";

const agentkit = await AgentKit.from({
  walletProvider, // any AgentKit wallet provider; these actions never use it
  actionProviders: [satohubActionProvider({ userAgent: "my-agent/1.0" }) /* , erc20ActionProvider(), ... */],
});

const preflight = agentkit.getActions().find((a) => a.name === "SatohubActionProvider_preflight")!;
console.log(await preflight.invoke({ targetType: "repo", target: "coinbase/agentkit", chain: null }));
```

The actions reach your model through AgentKit's framework extensions like any
other provider's: `getLangChainTools(agentkit)` from
`@coinbase/agentkit-langchain`, `getVercelAITools(agentkit)` from
`@coinbase/agentkit-vercel-ai-sdk`. A runnable version with a throwaway wallet
is in
[`examples/preflight.mjs`](https://github.com/satohubai/sato-hub-integrations/blob/main/packages/agentkit-satohub/examples/preflight.mjs).

Options are `satohub-core`'s client options: `userAgent` (please set it: it is
how Sato Hub tells a caller from a scanner), `baseUrl`, `timeoutMs`, `verify`,
or your own `client`.

## What an agent reads

[`examples/preflight.mjs`](https://github.com/satohubai/sato-hub-integrations/blob/main/packages/agentkit-satohub/examples/preflight.mjs), run from a clean install against satohub.ai on
2026-09-23 (evidence trimmed to three of six lines; `caveat` and `citation`
omitted):

```json
{
  "success": true,
  "verdict": "go",
  "meaning": "Sato Hub holds a record of this target and it meets every requirement of the rule named in `rule`. A verdict records what was checked and when; it is not a security review, an audit or a statement about returns.",
  "rule": "R5",
  "checkedAt": "2026-09-23T03:51:44.846Z",
  "target": { "kind": "repo", "value": "coinbase/agentkit", "name": "Coinbase AgentKit",
              "satoUrl": "https://satohub.ai/resources/coinbase-agentkit", "verifyUrl": "https://satohub.ai/verify/coinbase-agentkit" },
  "evidence": [
    { "check": "Directory record", "result": "Listed as Coinbase AgentKit (Developer Tool).", "sourceField": "resources.slug", "checkedAt": "2026-09-22" },
    { "check": "Sato Score", "result": "88 of 100, tier High. The score measures how open, active and verifiable the project is, not safety or quality.", "sourceField": "resources.trust_score", "checkedAt": "2026-09-22" },
    { "check": "Reproduced install", "result": "The documented install path was re-run in an isolated container and completed. Proves installability, not runtime behaviour.", "sourceField": "resources.deploy_spec.deploy_status", "checkedAt": "2026-09-21" }
  ],
  "signature": { "state": "verified", "kid": "b04bd38b", "signed_at": "2026-09-23T03:51:44.867Z" },
  "methodology": "https://satohub.ai/preflight/methodology",
  "source": "https://satohub.ai/api/preflight?repo=coinbase%2Fagentkit"
}
```

Each Preflight line names the field it was read from and when that field was
written. `source` is the full response, `methodology` is the rule set, and
`signature` says what the Ed25519 signature on the response proved (below).

## What the readings are, and are not

- A **Preflight verdict** (`go` | `caution` | `no` | `unknown`) names what was
  checked and when. It is not a security review, not an audit and not a
  statement about returns.
- **`unknown` means Sato Hub holds no record of the target. It is never a
  finding.** An unlisted package is not a suspicious package; the check simply
  has nothing to say, so decide by other means. The `meaning` field says this
  beside every `unknown`, so the model does not have to infer it.
- A **Sato Score** (0-100) measures how open, active and verifiable a project
  is. It is not a security review, not a quality judgment and not a statement
  about returns. The rubric is public: https://satohub.ai/sato-score
- **`null` means unknown.** It never means zero.
- `verificationStatus` distinguishes a self-reported claim from one Sato Hub
  verified. Present a `Self-Reported` claim as self-reported.

## Failures are failures

A network error, a timeout, a non-2xx answer, a malformed body or a signature
mismatch returns

```json
{ "success": false, "error": "… No result was produced: this is a failed request, not an 'unknown' verdict and not an empty result." }
```

with no `verdict` key. It is never turned into `unknown`, and never into `go`.
Node's `fetch failed` is expanded with its cause (`ENOTFOUND`,
`ECONNREFUSED`). When Sato Hub rejects a call (a token on a chain it does not
read, say) its own one-line reason is carried into the error so the model can
correct the call. A token check without a chain is refused before any request
is sent.

## Signatures

Preflight responses leave satohub.ai with a detached Ed25519 signature.
Requests go through [`satohub-core`](https://www.npmjs.com/package/satohub-core), which fetches the JWKS
and verifies the bytes as received. By default a signature that is present and
does not match is a failure and the content is not used (`verify: "report"`
only reports it). An unsigned response is reported as `unsigned`: unknown, not
invalid. Search results travel over MCP, which carries no signature header.

## Third-party text

Some of what comes back is written by or about third parties: listing names and
descriptions, a token's name read from its contract, the error a probed
endpoint gave. AgentKit's "Managing Risk" guidance names that as an indirect
prompt-injection surface. So every string copied into the action output has
control, zero-width and bidi characters removed and is length-bounded, URLs are
kept only if they parse as http(s), and `utm_*` parameters are dropped. The
text is not rewritten or summarised, and the action descriptions tell the model
to treat it as data. Search results keep the fields a builder decides on; the
full record is at each `satoUrl`.

## Citation

The data is free under CC-BY-4.0. Every listing carries a `satoUrl`. When an
agent surfaces one in an answer, cite that URL so the reader can check what the
record says today.

## Why this is not in the AgentKit repository

AgentKit takes third-party action providers by pull request, and one for Sato
Hub is written to its conventions. But no outside action provider has been
merged since March 2026, and the npm release (0.10.4, December 2025) predates
every change on `main` since. `ActionProvider` and `CreateAction` are public
exports of the published package, so a provider shipped as its own package
plugs in unchanged, today.

Note that AgentKit itself posts an analytics event to Coinbase each time an
action is invoked and when a wallet provider is created. That is AgentKit's
behaviour, not this package's; this package talks only to satohub.ai.

MIT. Source: https://github.com/satohubai/sato-hub-integrations
