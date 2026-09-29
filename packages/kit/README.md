# @satohub/kit

**0.1.0 preview.**

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

## Install

```sh
npm install @satohub/kit viem
npx -y @satohub/kit@0.1 --help
```

Node 20 or later. `viem` is a peer; every framework SDK below is an optional peer, installed only
if you use its subpath.

## Honest limits

- **Pre-flight, not enforcement.** `evaluatePreflight` runs before an intent is returned and names
  each refused rule with its limit and the observed value. Once a key is in play the kit enforces
  nothing: enforcement is the signer's (a CDP, Privy or Turnkey policy compiled from the same
  `policy.json`, OWS's policy engine, or a Safe's owners). `viemLocalSigner` enforces only its
  mainnet refusal.
- **x402 execution scope.** `x402.prepare` reads what an x402 resource asks to be paid and returns a
  priced, policy-checked intent. `execute` does not send x402 payments: it sends EVM transactions,
  EIP-712 typed data (Safe proposals) and Solana transactions only. Pay through your x402 client.
- **AgentKit's own analytics call.** AgentKit's `@CreateAction` decorator posts an invocation event
  to `cca-lite.coinbase.com` on every invoke. Actions consumed through `fromAgentKitProvider` still
  make that call; the kit neither blocks nor adds to it.
- **Unknown prices refuse.** When a USD value cannot be read, a `max_usd_*` rule refuses with
  `unknown_price` rather than guessing.
- **Simulation is not a promise.** A passing simulation says what the chain answered at that block.

## Action reference

Generated from the registered descriptors by `node scripts/gen-actions-doc.mjs` (after
`npm run build`); `test/readme-actions.test.ts` fails when this table drifts from the registry.
"custody" is the descriptor's own answer to three `sato.custody/v1` questions. `toolset` says
whether the tool is in the default MCP profile or only under `--toolsets all`.

<!-- BEGIN GENERATED: actions (scripts/gen-actions-doc.mjs) -->

### Registered actions

| action id | tool name | kind | effects | custody | chains | toolset |
| --- | --- | --- | --- | --- | --- | --- |
| `chain.read` | `chain_read` | read | `read` | reads key: no; key leaves: no; moves funds: never | ethereum, sepolia, base, base-sepolia, arbitrum, arbitrum-sepolia, optimism, optimism-sepolia, polygon | default, all |
| `swap.quote` | `swap_quote` | read | `quote` | reads key: no; key leaves: no; moves funds: never | ethereum, base, arbitrum, optimism, polygon | default, all |
| `swap.prepare` | `swap_prepare` | prepare | `quote`, `sign`, `broadcast` | reads key: no; key leaves: no; moves funds: with_approval | ethereum, base, arbitrum, optimism, polygon | default, all |
| `x402.prepare` | `x402_prepare` | prepare | `sign`, `pay` | reads key: no; key leaves: no; moves funds: with_approval | base, base-sepolia, ethereum, sepolia, polygon, arbitrum, optimism, solana, solana-devnet | default, all |
| `erc8004.lookup` | `erc8004_lookup` | read | `read` | reads key: no; key leaves: no; moves funds: never | ethereum, base, arbitrum, optimism, polygon | all |
| `tx.simulate` | `tx_simulate` | read | `simulate` | reads key: no; key leaves: no; moves funds: never | ethereum, sepolia, base, base-sepolia, arbitrum, arbitrum-sepolia, optimism, optimism-sepolia, polygon | all |
| `token.approvals.list` | `token_approvals_list` | read | `read` | reads key: no; key leaves: no; moves funds: never | ethereum, sepolia, base, base-sepolia, arbitrum, arbitrum-sepolia, optimism, optimism-sepolia, polygon | all |
| `token.approvals.revoke` | `token_approvals_revoke` | prepare | `sign`, `broadcast` | reads key: no; key leaves: no; moves funds: with_approval | ethereum, sepolia, base, base-sepolia, arbitrum, arbitrum-sepolia, optimism, optimism-sepolia, polygon | all |
| `erc8004.register` | `erc8004_register` | prepare | `sign`, `broadcast` | reads key: no; key leaves: no; moves funds: with_approval | ethereum, base, arbitrum, optimism, polygon | all |
| `bridge.quote` | `bridge_quote` | read | `quote` | reads key: no; key leaves: no; moves funds: never | ethereum, base, arbitrum, optimism, polygon | all |
| `bridge.prepare` | `bridge_prepare` | prepare | `quote`, `sign`, `broadcast` | reads key: no; key leaves: no; moves funds: with_approval | ethereum, base, arbitrum, optimism, polygon | all |
| `safe.info` | `safe_info` | read | `read` | reads key: no; key leaves: no; moves funds: never | ethereum, sepolia, base, base-sepolia, arbitrum, optimism, polygon | all |
| `safe.propose` | `safe_propose` | prepare | `sign` | reads key: no; key leaves: no; moves funds: with_approval | ethereum, sepolia, base, base-sepolia, arbitrum, optimism, polygon | all |
| `solana.read` | `solana_read` | read | `read` | reads key: no; key leaves: no; moves funds: never | solana, solana-devnet | all |
| `solana.transfer` | `solana_transfer` | prepare | `sign`, `broadcast` | reads key: no; key leaves: no; moves funds: with_approval | solana, solana-devnet | all |
| `solana.swap.quote` | `solana_swap_quote` | read | `quote` | reads key: no; key leaves: no; moves funds: never | solana | all |
| `solana.swap.prepare` | `solana_swap_prepare` | prepare | `quote`, `sign`, `broadcast` | reads key: no; key leaves: no; moves funds: with_approval | solana | all |

### Meta tools

| tool name | kind | effects | toolset |
| --- | --- | --- | --- |
| `execute` | execute | `sign`, `broadcast` | default, all |
| `status` | meta | `read` | default, all |
| `actions_search` | meta | `read` | default, all |
| `actions_describe` | meta | `read` | default, all |

Default MCP profile, in order: `chain_read`, `swap_quote`, `swap_prepare`, `x402_prepare`, `execute`, `status`, `actions_search`, `actions_describe`.

<!-- END GENERATED: actions -->

Actions consumed from an AgentKit provider (`fromAgentKitProvider`) are not in this table: they
are built at runtime from the provider you pass, and appear under toolset `all`.

## Entry points

| import | what it gives you |
| --- | --- |
| `@satohub/kit` | `createKit`, `coreActions`, the tool surface, config loader, everything below re-exported |
| `@satohub/kit/spec` | the vendored contracts: `sato.action/v1`, `sato.policy/v1`, `sato.receipt/v1`, id rules, descriptor lint |
| `@satohub/kit/policy` | `evaluatePreflight`; compilers `compileCdpPolicy`, `compilePrivyPolicy`, `compileTurnkeyPolicy` |
| `@satohub/kit/signers` | `viemLocalSigner`, `owsSigner`, `cdpSigner`, `solanaLocalSigner`, `humanApprove` |
| `@satohub/kit/intent` | intent store, HMAC intent ids (`loadOrCreateIntentSecret`, `verifyIntentId`) |
| `@satohub/kit/receipts` | the hash-chained `sato.receipt/v1` log |
| `@satohub/kit/actions` | every core action, descriptor and builder |
| `@satohub/kit/ai-sdk` | `satoKitTools(kit, opts)` for the Vercel AI SDK |
| `@satohub/kit/agentkit` | `satoKitActionProvider(kit, opts)` and `fromAgentKitProvider(provider, { chain })` |
| `@satohub/kit/claude-agent-sdk` | `createSatoKitSdkServer(kit, opts)` + `requireApprovalHook()` |
| `@satohub/kit/openai-agents` | `satoKitOpenAITools(kit, opts)` |
| `@satohub/kit/langchain` | `satoKitLangChainTools(kit, opts)` |
| `@satohub/kit/eliza` | `satoKitElizaPlugin(kit, opts)` (compatibility adapter, see below) |
| `@satohub/kit/mcp` | the local MCP server (stdio) |
| `@satohub/kit/cli` | the `sato-kit` CLI as a function |
| `@satohub/kit/sato-os` | `attachToSatoOs`, `proposeIntent` |
| `@satohub/kit/goat` | `fromGoatPlugin(plugin, { chain })` — consume an existing GOAT plugin with the kit's guarantees |

### Signers

- `viemLocalSigner` — a key in this process. Fork/testnet by default; refuses mainnet chain ids
  unless `allowMainnet: true` (not recommended). `generate: true` makes a throwaway in-memory key.
- `owsSigner` — a structural adapter over an Open Wallet Standard account; OWS's policy engine
  enforces. See `src/signers/OWS.md`.
- `cdpSigner` — a structural adapter over a Coinbase CDP server account; CDP enforces its policies.
  Pass a compiled policy as `nativePolicy` to carry it with the signer (the adapter does not register it).
- `solanaLocalSigner` — local Solana signing for devnet and tests only; refuses any non-devnet
  payload and a mainnet-beta RPC, with no mainnet switch.
- `humanApprove(signer, approve)` — wraps any signer so a person approves each summary before it signs.

### Policy compilers

`compileCdpPolicy`, `compilePrivyPolicy` and `compileTurnkeyPolicy` turn one `sato.policy/v1` into
the provider's native policy document. Each result lists what did not compile (`not_compiled`) with
the reason, so a rule the provider cannot express is never silently dropped.

### CLI

```
sato-kit read <action> --input '<json>'      run a read-only action
sato-kit prepare <action> --input '<json>'   build an intent; nothing is signed
sato-kit execute --intent <intent_id>        hand one prepared intent to the signer
sato-kit mcp [--toolsets default|all]        local MCP server over stdio
sato-kit doctor                              check config, Sato Status and template drift
```

Config comes from the working directory: `policy.json` (absent means the default policy, network
`fork`), `.sato/` (intents, intent secret, receipts), `SATO_RPC_URL_<CHAIN>` per chain, and
`SATO_SIGNER=viem-local-fork` (fork network only) for a local signer.

### MCP server

`npx -y @satohub/kit@0.1 mcp` runs a stdio MCP server (registry name `ai.satohub/kit`). The default
profile is the eight tools listed above; `--toolsets all` adds every other registered action.
Tools that sign carry `anthropic/requiresUserInteraction` in `_meta`.

### Sato Status

`status` and `sato-kit doctor` read the nightly per-action results (`sato.action-status/v1`)
published by the templates repo. When that file cannot be read, the answer says so; nothing is
filled in.

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

## Consuming an existing GOAT plugin (`@satohub/kit/goat`)

`await fromGoatPlugin(plugin, { chain })` works like `fromAgentKitProvider`: reads run as reads; a write runs the plugin's own tool against a capturing wallet that records the one transaction instead of sending it, and that transaction becomes an ordinary intent (simulate, pre-flight, `execute(intent_id)` once with your signer). Message or typed-data signing, a paymaster request, or more than one transaction is refused with the reason. GOAT has been quiet upstream; if your install holds two copies of `@goat-sdk/core`, GOAT's own wallet lookup can miss the wallet — keep one copy.

## Safe proposals

`safe.propose` builds the SafeTx for the Safe's owners to sign; the policy pre-flight applies to the call inside it. When the intent has a Safe Transaction Service target, `execute` signs and submits it and the receipt carries `safe_tx_hash`; without one, the receipt carries the signature as `typed_data_signature`. For Safe's hosted gateway, pass `safeTxService: { apiKey }` to `createKit` (or opt in to reading `SAFE_API_KEY`); the key is sent as `Authorization: Bearer …` only to `api.safe.global` or an origin you configure, and is never logged or written to a receipt.

## Solana

The Solana actions need a Solana RPC (`solanaRpc` in `createKit`). `solanaLocalSigner` is devnet-only and needs `@solana/kit` 8 or later installed next to the kit (`npm i @solana/kit@^8`); it is not declared as a peer so that installs holding an older `@solana/kit` (for example through AgentKit) still resolve.

## Not included: Stripe MPP

`mpp.prepare` is not built. Its client (`mppx`) is pre-1.0 with breaking changes in minor releases, and its payment methods do not map onto one unsigned transaction the kit's signer executes. Reasons and sources: [docs/mpp-research.md](docs/mpp-research.md).

## Sato OS hand-off (`@satohub/kit/sato-os`)

In live mode an agent can send prepared intents to a self-hosted Sato OS for a person's approval and signing there, instead of signing locally. `attachToSatoOs({ baseUrl, name, goal, walletAddresses, chains })` attaches the agent and stores its scoped token in `.sato/sato-os.json` (mode 0600, gitignored; never returned or printed). `proposeIntent(prepared, { baseUrl, token })` files the intent (unsigned payload, summary, policy verdict, simulation, fee disclosure) through Sato OS's `sato_os_create_action_proposal` tool and returns `{ proposal_id, status }`. A refused or expired intent is never sent. Nothing in this path signs or broadcasts.
