// Appended to the generated project README.
export const extraContents = `
# Sato Kit guarded swap

This project includes the [Sato Kit](https://github.com/satohubai/sato-hub-integrations/tree/main/packages/kit)
(\`@satohub/kit\`) and a **Guarded swap** page at \`/sato-swap\`.

## What it does

1. \`POST /api/sato/prepare\` (server) asks the kit to prepare one swap: it builds the unsigned
   transaction on the venue you pick, checks it against \`packages/nextjs/policy.json\` (spend caps,
   allowlists, slippage limit, intent expiry) and simulates it.
2. The page shows the summary, the pre-flight result (each refusal names its rule, limit and
   observed value), the simulation and the venue's fee sentence.
3. Only an intent that passed the pre-flight, simulated successfully and has not expired can be
   sent to your connected wallet. Your wallet's confirmation is the signature.

When your allowance is below the sell amount, the first intent is the **approve** transaction
(exact amount, never unlimited). Prepare again after it confirms to get the swap itself.

## What it does NOT do

- It holds no key and has no signer on the server. It cannot move funds on its own.
- The pre-flight is not enforcement: it explains refusals before your wallet is asked. What
  enforces is your wallet (and any policy your signer applies).
- It does not choose tokens for you, and it does not raise slippage to make a swap go through.
- It does not run on mainnet unless you set \`"network": "mainnet"\` in \`policy.json\` yourself.

## Run it on a local fork (default)

\`policy.json\` ships with \`"network": "fork"\`. The kit simulates against \`http://127.0.0.1:8545\`.
Start a node forked from Base there, keeping Base's chain id, for example:

\`\`\`bash
anvil --fork-url <your Base RPC URL> --port 8545
\`\`\`

Then point your wallet at that node (chain id 8453, RPC \`http://127.0.0.1:8545\`) and run \`yarn start\`.
Swaps are quoted by a live venue (\`direct\` = LI.FI, which does not contact Sato), so the page needs
network access for quotes.

## Configuration

- \`packages/nextjs/policy.json\` — the \`sato.policy/v1\` file. Missing fields take the kit's defaults.
- \`SATO_RPC_URL_BASE\` — the RPC the kit simulates against when the network is not \`fork\`.
- Venue \`sato\` is available and labelled; its fee sentence is shown verbatim, with a quote
  carrying no Sato fee alongside.
`;
