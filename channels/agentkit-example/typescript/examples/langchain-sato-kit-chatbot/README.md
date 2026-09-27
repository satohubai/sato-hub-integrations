# AgentKit LangChain Example - Chatbot with the Sato Kit

This example is a terminal chatbot with AgentKit's wallet actions plus the
[Sato Kit](https://github.com/satohubai/sato-hub-integrations/tree/main/packages/kit) tools. The Sato
Kit adds a prepare -> execute step in front of every action that moves funds: `prepare` builds the
unsigned transaction, checks it against `policy.json` (network, chain and token allowlists, spend
caps, slippage limit, intent expiry) and simulates it; `execute` takes only the returned
`intent_id`, and the person at the terminal approves each one.

The kit's policy check is a pre-flight: it explains refusals before the wallet is asked. The
wallet provider (here CDP) holds the key and applies its own policies.

## Ask the chatbot

- "What is my ETH balance on Base Sepolia?" (`chain_read`)
- "Quote a swap of 10 USDC for WETH on Base." (`swap_quote`)
- "Prepare that swap." (`swap_prepare`: refused by the pre-flight with `network_mainnet_not_enabled`,
  because `policy.json` allows `testnet` only. The refusal names its rule, limit and observed value.)
- "Look up ERC-8004 agent 1." (`erc8004_lookup`)

## What it does NOT do

- It does not sign without a person: `execute` and the signer both ask at the terminal, and only an
  explicit `y` approves. There is no autonomous mode.
- It does not run on mainnet: `policy.json` says `"network": "testnet"`. Mainnet needs the person to
  change that file.
- It does not treat the pre-flight as enforcement. What enforces is the wallet provider and its
  policies.
- It does not estimate an unknown USD value: with `unknown_verdict: "refuse"` such a trade is refused.

## Prerequisites

Node.js 22 or higher (the Sato Kit is an ES module). API keys as in the other chatbot examples:

- [CDP API Key](https://portal.cdp.coinbase.com/access/api)
- [OpenAI API Key](https://platform.openai.com/docs/quickstart#create-and-export-an-api-key)
- [Generate Wallet Secret](https://portal.cdp.coinbase.com/products/wallet-api)

Rename `.env-local` to `.env` and set `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`,
`OPENAI_API_KEY`. `SATO_RPC_URL_BASE_SEPOLIA` is the RPC the kit simulates against (defaults to
`RPC_URL`).

## Running the example

From the root directory:

```bash
pnpm install
pnpm build
```

Then from `typescript/examples/langchain-sato-kit-chatbot`:

```bash
pnpm start
```
