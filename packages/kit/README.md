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

## Consuming an existing AgentKit provider (`@satohub/kit/agentkit`)

`fromAgentKitProvider(provider, { chain })` turns each action of an AgentKit `ActionProvider` into kit actions. Read actions (a `get_`/`check_`/`list_`… name, or the names you pass as `reads`) become reads. Every other action runs the provider's own `invoke()` against a capturing wallet that records the transaction instead of sending it; that one transaction becomes an ordinary intent — simulated, put through the policy pre-flight, and sent once by `execute(intent_id)` with your signer.

```ts
import { erc20ActionProvider } from "@coinbase/agentkit";
import { fromAgentKitProvider } from "@satohub/kit/agentkit";

const { actions, not_consumable } = fromAgentKitProvider(erc20ActionProvider(), { chain: "base" });
const kit = createKit({ ...opts, actions: [...coreActions(), ...actions] });
```

- An action that tries to send more than one transaction, or to sign a message, typed data or a raw transaction, is refused with the reason. Nothing was sent, so nothing is partly done.
- A schema that cannot be made portable is listed in `not_consumable` with the lint's reasons rather than turned into a tool. An amount-named string with no pattern is narrowed to a decimal pattern and listed in `consumed[].tightened`.
- The USD value of a consumed action is unknown, so a `max_usd_*` cap refuses it under `unknown_price`; `max_per_trade` reads the ERC-20 amount or the native value off the captured transaction.
- AgentKit's own `@CreateAction` decorator posts an invocation analytics event to `cca-lite.coinbase.com` on every invoke; the kit does not block or add to it.
- Consumed actions appear under toolsets `"all"` and through `actions_search` / `actions_describe`; the default MCP profile is unchanged.

## Sato OS hand-off (`@satohub/kit/sato-os`)

In live mode an agent can send prepared intents to a self-hosted Sato OS for a person's approval and signing there, instead of signing locally. `attachToSatoOs({ baseUrl, name, goal, walletAddresses, chains })` attaches the agent and stores its scoped token in `.sato/sato-os.json` (mode 0600, gitignored; never returned or printed). `proposeIntent(prepared, { baseUrl, token })` files the intent (unsigned payload, summary, policy verdict, simulation, fee disclosure) through Sato OS's `sato_os_create_action_proposal` tool and returns `{ proposal_id, status }`. A refused or expired intent is never sent. Nothing in this path signs or broadcasts.
