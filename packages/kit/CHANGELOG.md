# Changelog — @satohub/kit

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
  Agents, LangChain and elizaOS; Sato OS hand-off (`attachToSatoOs`, `proposeIntent`).
- **Known limits.** The pre-flight explains; the signer enforces. `execute` does not send x402
  payments. AgentKit's own analytics call still happens for consumed AgentKit actions.
