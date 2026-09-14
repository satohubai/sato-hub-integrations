# elizaos-plugin-satohub

An elizaOS plugin that gives an agent four calls into
[Sato Hub](https://satohub.ai) — the scored, daily-rebuilt index of what onchain
agents are built from (frameworks, MCP servers, wallets, x402 and stablecoin
payment rails, ERC-8004 identity, trading venues, agent skills). The agent can
search that index, check a target before it installs or trades, get a swap venue
chosen on named readings with the fee disclosed, and turn a goal in plain words
into a build plan made only of listings that exist. Read-only, keyless,
non-custodial.

## Install

```sh
npm install elizaos-plugin-satohub
```

```ts
import satohubPlugin from "elizaos-plugin-satohub";

export const character = {
  name: "Builder",
  plugins: ["@elizaos/plugin-bootstrap", satohubPlugin],
};
```

No API key. No account. Settings, all optional:

| Setting | Default | Meaning |
|---|---|---|
| `SATOHUB_BASE_URL` | `https://satohub.ai` | Origin to call. |
| `SATOHUB_TIMEOUT_MS` | `20000` | Per-request deadline. |
| `SATOHUB_VERIFY` | `throw` | Signature handling: `throw`, `report`, `off`. |

## The actions

| Action | Answers |
|---|---|
| `SATOHUB_SEARCH_RESOURCES` | What is there to build this from? Is this project real, maintained and open source? |
| `SATOHUB_PREFLIGHT` | What is on record about this repo / package / MCP endpoint / ERC-8004 agent / token / skill? |
| `SATOHUB_ROUTE_SWAP_QUOTE` | Which venue would Sato Hub route this swap to, on what readings, and what is the fee? |
| `SATOHUB_BUILD_PLAN` | Here is the goal — what is the stack, and what is the first action? |

### Arguments

`SATOHUB_SEARCH_RESOURCES`, `SATOHUB_PREFLIGHT` and `SATOHUB_BUILD_PLAN` read
their arguments from `options` when the runtime supplies them, and otherwise
from the message with small deterministic rules — a `owner/repo`, a URL, a
`chain:id`, a `0x` address with the chain named beside it. No model runs in this
plugin. When nothing unambiguous is in the message, the action says so and stops
rather than guessing.

`SATOHUB_ROUTE_SWAP_QUOTE` **requires** `chain`, `token_in`, `token_out` and
`amount` in `options` or state. It will not read a trade size out of a sentence:
that is how someone trades 1000 of something they meant to trade 10 of. Amounts
are integer strings in the input token's smallest unit — 1 USDC is `"1000000"`.

## Non-custodial

This plugin never signs a transaction, holds a key, deploys anything, or moves
funds. The swap action returns a **quote** and calldata for your operator to
read and sign with its own signer; a route that is never signed costs nothing.
The Sato fee — 3 bps stable-to-stable, 15 bps on any volatile leg — is stated in
the response before anything is signed, including when it is zero.

## Signed responses

Preflight verdicts and Sato Route decisions leave satohub.ai with a detached
Ed25519 signature over the exact bytes. This plugin verifies it and, by default,
**fails the action** when a signature is present and does not match — a claim
that cannot be shown to be ours is not spoken as fact. An unsigned response is
reported as unsigned: **unknown, not invalid**. Each action's `data.signature`
carries `verified` / `unsigned` / `skipped` / `failed` so an operator reading the
trace can see which it was. [The scheme.](https://satohub.ai/.well-known/sato-signing.json)

## What the readings are, and are not

- A **Sato Score** measures how open, active and verifiable a project is. It is
  not a security review, a quality judgment or a statement about returns.
- A **Preflight verdict** names what was checked and when. `unknown` means Sato
  Hub holds no record — not that anything is wrong.
- A **route** is a recommendation, chosen by the fields named in `chosen_by`. A
  quote is not a fill.
- **`null` means unknown.** It never means zero — this plugin's renderers print
  a missing number as "unknown" and never as 0.

## Citation

The data is free under CC-BY-4.0. Every listing carries a `sato_url` — its
canonical page. When your agent uses one in an answer, cite that URL so the
reader can check what the record says today.

MIT. Source: https://github.com/satohubai/sato-hub-integrations
