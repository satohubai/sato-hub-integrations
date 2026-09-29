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
console.log((data as { verdict: string }).verdict, signature.state); // "go" "verified"
```

The complete version of that — with the response it returns — is the next
section.

Please set `userAgent`. It is the only thing that distinguishes a caller from a
scanner.

## One complete example: run Preflight before you install

Preflight is the call to reach for first. Give it one target — a repo, an npm
package, an MCP endpoint, an ERC-8004 agent, a token or a skill — and it answers
with what is on record about it, and when each thing was checked, *before* you
install, connect, pay or trade.

```ts
// preflight.ts — runs on Node 20+ with no key and no account.
// npm install satohub-core && npx tsx preflight.ts
import { SatoHubClient } from "satohub-core";

const sato = new SatoHubClient({ userAgent: "my-agent/1.0" });

const { data, signature } = await sato.preflight({ repo: "coinbase/agentkit" });
const report = data as {
  verdict: "go" | "caution" | "stop" | "unknown";
  rule: string;
  target: { kind: string; value: string; slug: string; name: string; sato_url: string; verify_url?: string };
  evidence: Array<{ check: string; result: string; source_field: string; checked_at: string }>;
  checked_at: string;
  caveat: string;
};

console.log(report.verdict, report.rule, signature.state);
for (const e of report.evidence) console.log(`- ${e.check}: ${e.result}`);
console.log("cite:", report.target.sato_url);
```

What comes back (an actual response, trimmed — every field below is real):

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
    { "check": "Public activity", "result": "Last public activity 4d ago (active).",
      "source_field": "resources.last_activity_at", "checked_at": "2026-09-17T19:33:38.000Z" },
    { "check": "Sato Score", "result": "88 of 100, tier High. The score measures how open, active and verifiable the project is, not safety or quality.",
      "source_field": "resources.trust_score", "checked_at": "2026-09-21" }
  ],
  "checked_at": "2026-09-22T02:00:52.098Z",
  "caveat": "A Preflight verdict names what was checked and when … Unknown means we hold no record — not that anything is wrong.",
  "meta": {
    "rules": [ … ],
    "coverage": { "daily": { "finished_at": "…", "steps_ok": 40, "steps_failed": [] }, "weekly": { … } },
    "next_update": { "daily": "…", "weekly": "…" },
    "signature": { "alg": "EdDSA", "kid": "b04bd38b", "sig": "…", "signed_at": "…",
                   "jwks_url": "https://satohub.ai/.well-known/jwks.json" }
  }
}
```

and the `signature` returned beside it:

```jsonc
{ "state": "verified", "kid": "b04bd38b", "signed_at": "2026-09-22T02:00:52.118Z" }
```

`verdict` is one of `go`, `caution`, `stop` or `unknown`, `rule` names the rule
that produced it, and `evidence` is the whole basis for it — each row saying
which field was read and when. `unknown` means Sato Hub holds no record, not
that anything is wrong. `data` is typed `unknown` on purpose: the wire shape is
Sato Hub's, not ours, so you narrow it yourself (or use the Zod schemas below).

The other three calls have the same shape — `{ data, signature }`:

```ts
await sato.searchResources({ query: "x402 payment rail", chain: "Base", limit: 5 });
await sato.routeSwap({ chain: "Base", token_in: "USDC", token_out: "WETH", amount: "1000000" });
await sato.buildPlan({ goal: "a Base trading agent that swaps USDC to ETH on a signal" });
```

`amount` is an integer string in the input token's smallest unit — 1 USDC is
`"1000000"`, never `1` and never `"1.0"`.

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

## Sato Scan: check the recipient before you sign

Address poisoning and fake stablecoins both work by looking right at a glance.
Two offline checks run in your agent's own signing path, before anything is
signed. They read what you pass in against a stablecoin table that ships in this
package (a record of what each issuer names for its token on each chain, dated
`SCAN_TABLE_AS_OF`). No network, no key, nothing is sent.

```ts
import { scanRecipient, sanitizeTransfers, checkRecipientHosted } from "satohub-core";

const r = scanRecipient({
  chain: "Base",
  to: payTo,                                   // where the 402 says to pay
  token: { address: asset, symbol: "USDC" },   // by contract address; the symbol is only a label
  book: knownAddresses,                        // addresses you have paid or been paid by
  allowRecipients: policy.allow_recipients,    // as in policy.json: chain-qualified, e.g. "base:0x..."
  treasury: false,                             // true: `to` must be in allowRecipients
  policy: policy.scan,                         // the generated `scan` block; omit for the strict defaults
});
if (r.verdict === "no") throw new Error(`${r.rule}: ${r.reason} (limit: ${r.limit})`);

// Transfer history from an indexer: drop rows whose token imitates a stablecoin.
const { rows, removed, unchecked, notes } = sanitizeTransfers(history, { chain: "Base" });
```

`allowRecipients` and `book` take the entries as they are written in `policy.json`,
chain-qualified as `<chain>:<address>` (`base:0x...`). Only the entries for `chain`
are used; entries for other chains are ignored and counted in `notes`. A raw address
with no `<chain>:` prefix is accepted and applies to `chain`. EVM addresses compare
case-insensitively; Solana addresses are case-sensitive.

- A token whose address is not the listed contract but which is labelled as a
  stablecoin is refused (`token.not_canonical`). The symbol never rescues a
  wrong address.
- A recipient that differs from a known address but agrees with it on the first
  3 or more and last 3 or more characters, 7 or more together, is refused
  (`recipient.lookalike`), with the address it imitates and the matched ends.
- A recipient that is exactly in `book` (or `allowRecipients`) is still compared with
  the entries recorded before it. If it imitates one, the answer is `caution` with
  `recipient.lookalike_in_book`, naming the earlier address, under `refuse` and
  `caution` alike (`off` skips it). "Before" means list position: `allowRecipients`
  counts as recorded before `book`, and inside each list the first entry is the
  oldest. An entry that imitates nothing recorded before it stays `go`. Pass `book`
  oldest first: an unordered book gives order-dependent answers, and an
  `allowRecipients` entry is never flagged against a later `book` entry.
- In treasury mode a recipient outside `allowRecipients` is refused
  (`recipient.not_allowlisted`).
- An address that imitates nothing you know is `unknown`: this check holds no
  record of it. `go` means an address you already know and nothing found in the
  token check. Neither is a statement that an address or token is fine.

`sanitizeTransfers` reads a token address only from an explicit token field:
`token_address`, `tokenAddress`, `contractAddress`, `contract_address` or `mint`, and
`contract` or `token` when the value is address-shaped for the chain (a symbol or a
nested object there is not an address). A row's `address` field is never read: in
indexer output it is usually a wallet, not the token. Pass `read` for a row shape it
does not know. A row
that carries a stablecoin label but no readable token address cannot be checked: it
is kept, returned in `unchecked`, and counted in `notes`. Kept is not checked.

This is a pre-flight. Enforcement lives in the signer that calls it. Generated
`policy.json` files carry a `scan` block; `SCAN_POLICY_DEFAULTS` holds the strict
defaults, and `resolveScanPolicy` reads a block that was hand-edited or partial:
an undefined, misspelt or wrong-typed value uses the default for that field (and says
so in `notes`), never "off". What each field does here:

| field | read by `scanRecipient` |
| --- | --- |
| `lookalike` | yes: `refuse` (default), `caution`, `off` |
| `token` | yes: `refuse_not_canonical` (default), `off` |
| `treasury_recipients` | yes: `allowlist_only` (default), `off`, applied when you pass `treasury: true` |
| `payto_changed` | no. Recorded in `policy.json` and enforced only by hosts that implement it; this offline guard does not enforce it today (it is not given the payee's earlier value) |
| `hosted_check` | no. A signal for your code: call `checkRecipientHosted` when `true`; `scanRecipient` never makes a network call |

`params` overrides the look-alike numbers (`prefix_min`, `suffix_min`, `total_min`,
`solana_prefix_min`, `solana_suffix_min`). A value is used only if it is a whole
number from 1 up to the address body it counts (40 for EVM, 44 for Solana, 80 for
`total_min`); `undefined`, `NaN`, zero, a negative, a fraction, an oversized value or a
non-number uses the default for that field and says so in `notes`, so a bad value never
loosens the rule.

The `scan` block is not part of `policy_digest` (that hash covers the policy as bound,
before the block is added); the manifest's sha256 of `policy.json` does cover it.

`checkRecipientHosted` is optional. The hosted check sends `chain`, `to` and `token` only. `from`, `origin` and `amount` are sent only if the caller opts in.
It posts to `/api/scan/recipient` and returns the signed `sato.scan.recipient/v1`
reading (watchlist, declared payTo history). Opt in per field with
`include: ["from"]` (the paying wallet, which enables the checks that need history),
`"origin"` or `"amount"`; a field on the input that is not named in `include` is not
sent, and nothing outside those four fields ever is. It fails open: a failed call comes
back as `unknown` with the error, a 4xx is never retried, and it never blocks a
payment by itself.

```ts
await checkRecipientHosted({ chain: "Base", to: payTo, token: asset, from: myWallet });                     // sends chain, to, token
await checkRecipientHosted({ chain: "Base", to: payTo, token: asset, from: myWallet }, { include: ["from"] }); // also sends from
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
