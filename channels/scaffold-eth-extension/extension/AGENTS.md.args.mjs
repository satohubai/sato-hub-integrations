export const extraProjectOverview = `
### About the Sato Kit guarded swap

This project includes \`@satohub/kit\` and a \`/sato-swap\` page. \`POST /api/sato/prepare\` prepares one swap (unsigned transaction, policy pre-flight against \`packages/nextjs/policy.json\`, simulation); the browser wallet signs only an intent that passed the pre-flight, simulated successfully and has not expired (\`utils/sato/walletTx.ts\` \`walletTxFor\`).
`;

export const extraSections = `
## Sato Kit

### What the Sato Kit guarded swap does NOT do

- It holds no key and has no signer on the server. It cannot move funds on its own.
- The pre-flight is not enforcement: it explains refusals before your wallet is asked. What
  enforces is your wallet (and any policy your signer applies).
- It does not choose tokens for you, and it does not raise slippage to make a swap go through.
- It does not run on mainnet unless you set \`"network": "mainnet"\` in \`policy.json\` yourself.

Rules for an agent editing this project: never edit \`policy.json\` to get past a refusal, never switch its \`network\` to \`mainnet\` on the person's behalf, and never send a transaction that did not come from \`walletTxFor\`.
`;
