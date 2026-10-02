# Changelog — @satohub/kit

## Unreleased

- **ODA licence.** The Onchain Action Descriptor spec is now licensed under Apache-2.0 (copyright
  2026 Prime Signal LLC). `src/spec` carries the re-vendored README (§10 Licence), `LICENSE` and
  `NOTICE`; the package ships `LICENSE-ODA` and a `NOTICE` saying `dist/spec` is Apache-2.0 while the
  rest of the kit stays MIT. No code changed.

## 0.1.1 — policy.json accepts the Sato Scan `scan` block

Release date: set on the day it is published to npm.

- **`sato.policy/v1` `scan` block (additive).** `@satohub/kit/spec` re-vendors `policy.ts` from the
  app: `parsePolicyFile` accepts an optional `scan` object (`lookalike`, `token`, `payto_changed`,
  `treasury_recipients`, `hosted_check`), fills omitted fields from `SCAN_POLICY_DEFAULTS` and
  refuses unknown keys or values by name. A policy without `scan` parses exactly as before. The
  block is not part of `policyDigest`.
- **Why a release.** 0.1.0 refuses any unknown property in `policy.json`, so a template can only
  declare `scan` once it vendors this version. The checks themselves run in `satohub-core`
  (`scanRecipient`, 0.2.2); the kit records the settings. `payto_changed` is recorded, not enforced
  (README).

## 0.1.0 — first release

Release date: set on the day it is published to npm.

First public version. Everything below is new.

- **Contract.** prepare -> execute: an action returns an unsigned intent with a policy pre-flight
  result, a simulation and a fee disclosure; `execute({ intent_id })` hands exactly that intent to
  a signer and appends a hash-chained `sato.receipt/v1` line. Contracts `sato.action/v1`,
  `sato.policy/v1`, `sato.receipt/v1` vendored under `@satohub/kit/spec`.
- **Actions.** `chain.read`, `swap.quote`, `swap.prepare`, `x402.prepare`, `erc8004.lookup`,
  `erc8004.register`, `tx.simulate`, `token.approvals.list`, `token.approvals.revoke`,
  `bridge.quote`, `bridge.prepare`, `safe.info`, `safe.propose`, `solana.read`,
  `solana.transfer`, `solana.swap.quote`, `solana.swap.prepare`. Full table in the README.
- **Policy.** `evaluatePreflight` (names each refused rule with limit and observed value);
  compilers to CDP, Privy and Turnkey native policies, each listing what did not compile.
  Network defaults to `fork`; mainnet needs a `policy.json` that says so.
- **Signers.** `viemLocalSigner` (refuses mainnet unless opted in), `owsSigner`, `cdpSigner`,
  `solanaLocalSigner` (devnet only), `humanApprove`.
- **Doors.** `sato-kit` CLI (`read`, `prepare`, `execute`, `mcp`, `doctor`); local stdio MCP server
  (`ai.satohub/kit`, default profile of eight tools, `--toolsets all` for the rest); adapters for
  the AI SDK, AgentKit (both directions, incl. `fromAgentKitProvider`), Claude Agent SDK, OpenAI
  Agents, LangChain and elizaOS; GOAT plugin consumption (`@satohub/kit/goat`); Sato OS hand-off
  (`attachToSatoOs`, `proposeIntent`).
- **Receipts.** `safe_tx_hash` for submitted Safe proposals, `typed_data_signature` when a Safe
  proposal is signed but not submitted, `signature` for Solana transactions.
- **Safe gateway.** Optional API key for Safe's hosted gateway, sent only to its own origin or one
  you configure; never logged.
- **Known limits.** The pre-flight explains; the signer enforces. `execute` does not send x402
  payments. AgentKit's own analytics call still happens for consumed AgentKit actions.
  `solanaLocalSigner` needs `@solana/kit` 8+ installed separately. Stripe MPP is not included
  (see docs/mpp-research.md).
