# @satohub/kit

**Unpublished. 0.1.0 preview.**

Sato Kit wraps the tools agents already use (viem, signers, x402) with a prepare -> execute
contract: an action prepares an unsigned intent, a policy pre-flight explains any refusal,
the transaction is simulated, and `execute({ intent_id })` hands it to your signer and appends
a hash-chained `sato.receipt/v1` line.

What it is not: not a wallet, not a custodian, not an agent framework, and not a guarantee.
It never holds funds and ships no keys.

- **Fork by default.** A policy's `network` defaults to `fork`; mainnet needs an explicit opt-in.
- **Pre-flight vs enforcement.** The kit's policy check runs before an intent is returned and says
  which rule refused and why. It does not enforce anything once a key is in play. Enforcement lives
  in the signer (e.g. a CDP policy compiled from the same file).
- **Swaps are venue-neutral.** Any venue is accepted. Sato Swap is the labelled default and its fee is
  disclosed on every response, with a no-Sato-fee quote alongside; `venue: "direct"` skips Sato entirely.

Contracts (`sato.action/v1`, `sato.policy/v1`, `sato.receipt/v1`) live in `src/spec` (see `VENDORED.md`).

## Recommended .gitignore

The file intent store and the intent HMAC secret live under `.sato/` by default
(`intents/`, `intent.key`, mode 0600). Keep them out of version control:

```gitignore
.sato/
```

License: MIT

## Host adapters: envelope and error codes

`@satohub/kit/ai-sdk` (`satoKitTools(kit, opts)`), `@satohub/kit/agentkit`
(`satoKitActionProvider(kit, opts)`) and `@satohub/kit/claude-agent-sdk`
(`createSatoKitSdkServer(kit, opts)` + `requireApprovalHook()`) are built from
the same tool surface as the local MCP server (`sato-kit mcp`). Options:
`{ toolsets?, actions?, policy?, signerKind?, fetch?, statusTimeoutMs? }`
(AgentKit also takes `approve`). Each adapter tool returns one envelope:

- `{ ok: true, tool, result }`
- `{ ok: false, tool, error: { code, message, refusals? }, intent? }`

Error codes: `unknown_tool`, `invalid_input`, `policy_refused`,
`approval_required`, `approval_denied`, `not_configured`, `error`. A policy
refusal lists each `{ rule, limit, observed }`. `execute` takes `{ intent_id }`
and nothing else, and every host asks a person before it runs.

On the MCP server a refused prepare is a normal result whose
`structuredContent.policy.refusals` names each rule; a failed call sets
`isError` and carries its detail in `_meta["ai.satohub/error"]`.
