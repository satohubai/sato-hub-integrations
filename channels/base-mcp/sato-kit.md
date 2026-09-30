---
title: "Sato Kit Plugin"
description: "Policy pre-flight and simulation for swaps via the Sato Kit CLI → send_calls on Base; the pre-flight explains refusals, Base Account approval is the signature."
tags: [swap, dex, ai-agents, policy]
name: sato-kit
version: 0.1.1
integration: cli-only
chains: [base, base-sepolia]
requires:
  shell: required
  allowlist: []
  externalMcp: null
  cliPackage: "npx -y @satohub/kit@0.1.1"
auth: none
risk: [slippage, irreversible, local-exec]
---

# Sato Kit Plugin

> [!IMPORTANT]
> Run Base MCP onboarding first (see SKILL.md). This plugin needs a shell: it runs the Sato Kit CLI on the user's machine before anything reaches Base MCP.

## Overview

Sato Kit is an open-source (MIT) TypeScript library and CLI that turns an onchain action into two steps: `prepare` builds an unsigned transaction, checks it against the user's own `policy.json` (spend caps, token and contract allowlists, slippage limit, intent expiry) and simulates it; only then is the transaction handed to a signer. In this plugin the signer is the user's Base Account: the agent runs `prepare` through the CLI, shows the user the summary, the simulation and the pre-flight result, and submits the returned **unsigned calldata** to Base MCP `send_calls`, where the user approves it. The kit's pre-flight explains refusals before a request is made; the Base Account approval is what signs. Swaps run on `base`; chain reads also run on `base-sepolia`.

## Installation

No install step. The CLI runs per call through `npx` with a pinned version:

```bash
npx -y @satohub/kit@0.1.1 --version
npx -y @satohub/kit@0.1.1 doctor --json
```

The CLI reads `./policy.json` (a `sato.policy/v1` file) from the working directory. Without one, the default policy is in force: network `fork`, which refuses every mainnet request. The user opts in to a real network by writing it into their own policy file; the agent must not write or edit that file on the user's behalf. A minimal Base mainnet policy the user can start from:

```json
{
  "schema": "sato.policy/v1",
  "version": 1,
  "network": "mainnet",
  "allow_chains": ["base"],
  "max_usd_per_trade": 25,
  "max_usd_per_day": 100,
  "max_slippage_bps": 100,
  "unknown_verdict": "refuse",
  "human_approval": true
}
```

RPC for simulation: `SATO_RPC_URL_BASE` (and `SATO_RPC_URL_BASE_SEPOLIA` for reads there). The user sets these; the plugin never asks for their values in chat.

## Surface Routing

| Capability | Harness with a shell (Claude Code, Codex, Cursor) | Chat-only surface (Claude.ai, ChatGPT) |
|---|---|---|
| Chain read (`chain.read`) | Shell: `npx -y @satohub/kit@0.1.1 read chain.read ...` | Stop |
| Swap quote (`swap.quote`) | Shell: `npx -y @satohub/kit@0.1.1 read swap.quote ...` | Stop |
| Swap prepare + pre-flight + simulation (`swap.prepare`) | Shell: `npx -y @satohub/kit@0.1.1 prepare swap.prepare ...` | Stop |
| Submit | Base MCP `send_calls` | Stop |

This plugin is `cli-only`. On a surface with no shell, tell the user the Sato Kit pre-flight runs locally and needs a shell (Claude Code, Codex or Cursor), then stop. Do not improvise a `web_request` or paste workaround, and do not skip the pre-flight and submit a swap some other way under this plugin's name. For the general decision tree see [../references/custom-plugins.md](../references/custom-plugins.md).

## Commands

Every command prints JSON with `--json`. Exit code `0` = ok, `2` = refused by policy, `1` = error. Action names accept the ODA id (`swap.prepare`) or the tool name (`swap_prepare`).

### `read chain.read`

```bash
npx -y @satohub/kit@0.1.1 read chain.read --json \
  --input '{"chain":"base","kind":"erc20_balance","address":"<wallet>","token":"<token address>"}'
```

`kind` is one of `native_balance`, `erc20_balance`, `erc20_allowance`, `block_number`, `contract_read`. Output: the value read plus the block it was read at. No signature, no funds move.

### `read swap.quote`

```bash
npx -y @satohub/kit@0.1.1 read swap.quote --json \
  --input '{"chain":"base","sell_token":"<address>","buy_token":"<address>","sell_amount":"<base units>","venue":"direct"}'
```

`venue` is `sato` (the labelled default; its fee sentence is returned verbatim in `fee_disclosure`, with a quote carrying no Sato fee alongside), `direct` or `lifi` (LI.FI only; Sato is not contacted), or `0x` (needs the user's own `zeroex_api_key`). Output: the quote, the venue and the fee disclosure.

### `prepare swap.prepare`

```bash
npx -y @satohub/kit@0.1.1 prepare swap.prepare --json \
  --input '{"chain":"base","sell_token":"<address>","buy_token":"<address>","sell_amount":"<base units>","taker":"<wallet>","slippage_bps":50,"venue":"direct"}'
```

Output: a `PreparedIntent`:

| Field | Meaning |
|---|---|
| `intent_id` | `si_…` id bound to these exact parameters |
| `summary` | One plain sentence the user can approve or refuse |
| `policy.ok` / `policy.refusals[]` | Pre-flight result; each refusal names `rule`, `limit`, `observed` |
| `simulation` | Result of simulating the unsigned transaction |
| `fee_disclosure` | The venue's fee sentence, verbatim, or null |
| `unsigned` | `{ kind: "evm_tx", chain, chain_id, from, to, data, value }` — `value` is wei as a **decimal** string |
| `expires_at` | After this time, prepare again |

When the taker's allowance to the venue's spender is below `sell_amount`, `prepare` returns the **approve** transaction (exact amount, never unlimited) and says so in `summary`. Once that approval has landed, running `prepare` again returns the swap itself. One intent is one transaction.

## Orchestration

### Swap

1. Get the user's address with Base MCP `get_wallets`.
2. Resolve token addresses (ask the user, or read them from a source they name). Never default to a token.
3. Run `read swap.quote` and show the quote, the venue and `fee_disclosure` verbatim.
4. Run `prepare swap.prepare` with `taker` = the wallet from step 1.
5. If the exit code is `2` or `policy.ok` is `false`: report every refusal (`rule`, `limit`, `observed`) and stop. Do not retry with changed numbers to get around a rule, and do not edit `policy.json`.
6. Check `simulation` succeeded and `unsigned.chain` is the chain the user asked for. If not, stop and report.
7. Show the user `summary`, `simulation`, `fee_disclosure` and the pre-flight result verbatim, and ask them to approve that exact intent.
8. Submit `unsigned` through `send_calls` (see `## Submission`). The user approves in Base Account.
9. If step 4 returned the approve transaction, wait for it to confirm, then run `prepare swap.prepare` again (steps 4–8) for the swap itself.

### Read

1. Run `read chain.read` (or `read swap.quote`) and report the JSON result. Nothing is submitted.

## Submission

Target tool: **`send_calls`**.

Map the `PreparedIntent.unsigned` object (only when `unsigned.kind` is `evm_tx`):

| `send_calls` field | From |
|---|---|
| `chain` | `unsigned.chain` (`base`) — it must equal the chain the user asked for |
| `calls[0].to` | `unsigned.to` |
| `calls[0].data` | `unsigned.data` |
| `calls[0].value` | `unsigned.value` converted from a decimal wei string to hex (`"0"` → `"0x0"`, `"1000000000000000"` → `"0x38d7ea4c68000"`) |

One intent is one call. Never merge calls from two different intents into one batch, never change `to`, `data` or `value`, and never submit an intent whose `policy.ok` is `false` or whose `expires_at` has passed. The approval and polling flow is in [../references/approval-mode.md](../references/approval-mode.md).

The kit's own `execute` command and its local receipt log are not used on this path: Base Account signs, and the Base MCP approval result is the record.

## Example Prompts

**"Swap 10 USDC for WETH on Base, max 1% slippage."**
1. `get_wallets` → address.
2. `read swap.quote` with `sell_amount` `10000000`, `venue` `direct`; show the quote and fee disclosure.
3. `prepare swap.prepare` with `slippage_bps` `100`.
4. The result is the approve step: show `summary`; on approval, `send_calls` with that one call; wait for confirmation.
5. `prepare swap.prepare` again → swap intent; show `summary`, `simulation`, `fee_disclosure`; on approval, `send_calls`.

**"Swap 500 USDC for ETH."** (above the user's `max_usd_per_trade` of 25)
1. `prepare swap.prepare` exits `2` with a `max_usd_per_trade` refusal (limit `25`, observed `500`).
2. Report the refusal as returned and stop. Do not split the trade into smaller ones to pass the rule.

**"What is my USDC balance on Base Sepolia?"**
1. `get_wallets` → address.
2. `read chain.read` with `chain` `base-sepolia`, `kind` `erc20_balance`, `token` `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Report the value and block.

**(Claude.ai) "Use Sato Kit to swap 5 USDC."**
1. No shell on this surface: say the Sato Kit pre-flight runs locally and needs Claude Code, Codex or Cursor, then stop.

## Risks & Warnings

- **`slippage`** — a swap can fill worse than quoted. The pre-flight refuses a `slippage_bps` above the user's `max_slippage_bps`. Never raise `slippage_bps` to make a refused or failed swap go through; ask the user.
- **`irreversible`** — a submitted transaction cannot be undone. Show `summary`, `simulation` and `fee_disclosure` before every `send_calls`, and submit only the exact intent the user approved.
- **`local-exec`** — this plugin runs a third-party npm package (`@satohub/kit`, pinned to `0.1.1`) on the user's machine. The user is installing and running that code; tell them so the first time, and never replace the pinned version with `@latest`.
- **Pre-flight is not enforcement.** The kit's policy check explains refusals before a request is made; it does not control the key. Enforcement is the Base Account approval, which the user gives or withholds per request.
- **Unknown USD value.** When the kit cannot price a trade and the policy says `unknown_verdict: "refuse"`, the pre-flight refuses with `unknown_price`. Do not estimate a price to get past it.

## Notes

- Source and license: `github.com/satohubai/sato-hub-integrations` (`packages/kit`), MIT. Contracts: `sato.action/v1`, `sato.policy/v1`, `sato.receipt/v1`.
- Chain strings used by the kit and Base MCP match for `base` and `base-sepolia`.
- `swap.prepare` / `swap.quote` support `base` (not `base-sepolia`); `chain.read` supports both.
- USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. USDC on Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- The kit identifies itself with the `@satohub/kit` user-agent on the requests it makes to swap venues and RPCs.
