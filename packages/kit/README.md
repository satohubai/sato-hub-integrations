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

## `sato-kit doctor`: template drift

In a repo made by create-sato-agent (one with `sato.create.json`), `doctor`
also sends `sato.create.json` and `sato.lock.json` to
`https://satohub.ai/api/create/drift` (3 s timeout) and prints the changes it
returns: a newer template version that passed its checks, a custody change in
a stored Sato Check profile for a pinned package, or a pinned package version
that fails the template checks upstream. It is read-only and opens no issues
(the generated `sato-drift.yml` workflow does that). With `--json` the answer
is under `result.drift`, with `state` `checked`, `unavailable` (with a
`reason`) or `not_applicable`; nothing is filled in when the check does not
answer.

## Host adapters: envelope and error codes

`@satohub/kit/ai-sdk` (`satoKitTools(kit, opts)`), `@satohub/kit/agentkit`
(`satoKitActionProvider(kit, opts)`), `@satohub/kit/claude-agent-sdk`
(`createSatoKitSdkServer(kit, opts)` + `requireApprovalHook()`),
`@satohub/kit/openai-agents` (`satoKitOpenAITools(kit, opts)`, OpenAI Agents
SDK function tools with `needsApproval`), `@satohub/kit/langchain`
(`satoKitLangChainTools(kit, opts)`, LangChain JS `DynamicStructuredTool`s
whose func returns the envelope as a JSON string) and `@satohub/kit/eliza`
(`satoKitElizaPlugin(kit, opts)`) are built from the same tool surface as the
local MCP server (`sato-kit mcp`). Options:
`{ toolsets?, actions?, policy?, signerKind?, fetch?, statusTimeoutMs? }`
(AgentKit, LangChain and elizaOS also take `approve`; none of these hosts has an approval step,
so `execute` is refused without it).

`@satohub/kit/eliza` is a thin compatibility adapter for existing elizaOS 1.x
agents, not a supported framework: no Sato template depends on elizaOS, and
the subpath is dropped rather than patched if an elizaOS release breaks it.
Its actions read arguments from `options.parameters` (then
`message.content.parameters`). Each adapter tool returns one envelope:

- `{ ok: true, tool, result }`
- `{ ok: false, tool, error: { code, message, refusals? }, intent? }`

Error codes: `unknown_tool`, `invalid_input`, `policy_refused`,
`approval_required`, `approval_denied`, `not_configured`, `error`. A policy
refusal lists each `{ rule, limit, observed }`. `execute` takes `{ intent_id }`
and nothing else, and every host asks a person before it runs.

On the MCP server a refused prepare is a normal result whose
`structuredContent.policy.refusals` names each rule; a failed call sets
`isError` and carries its detail in `_meta["ai.satohub/error"]`.
