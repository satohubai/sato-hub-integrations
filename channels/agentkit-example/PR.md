<!-- PR title: chore: add langchain-sato-kit-chatbot example -->

## Description

Adds `typescript/examples/langchain-sato-kit-chatbot`, a LangChain chatbot that combines AgentKit's
wallet actions with the Sato Kit (`@satohub/kit`, MIT) through its AgentKit action provider
(`satoKitActionProvider`).

What the example shows: a prepare -> execute step in front of actions that move funds. `prepare`
builds the unsigned transaction, checks it against a `policy.json` pre-flight (network, allowlists,
spend caps, slippage, expiry) and simulates it; `execute` takes only the returned `intent_id`, and
the person at the terminal approves each signature. A refusal names its rule, limit and observed
value. The wallet provider (CDP) holds the key and applies its own policies; the pre-flight only
explains refusals before the wallet is asked.

It is additive: one new directory under `typescript/examples/`, no change to any package.

## Tests

```
Chatbot: typescript/examples/langchain-sato-kit-chatbot/chatbot.ts
Network: Base Sepolia
Setup: <fill in at submission: funding used, if any>

Prompt: What is my ETH balance on Base Sepolia?
<paste agent output>

Prompt: Prepare a swap of 10 USDC for WETH on Base.
<paste agent output: refused with network_mainnet_not_enabled>
```

## Checklist

- [x] Added documentation to all relevant README.md files
- [ ] Added a changelog entry (examples are private packages; confirm with maintainers whether one is needed)
