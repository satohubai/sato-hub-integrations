# Scaffold-ETH 2 extension: Sato Kit guarded swap (draft, not submitted)

A [create-eth](https://github.com/scaffold-eth/create-eth) extension that adds `@satohub/kit` to the
Next.js package and a **Guarded swap** page and hook. Layout follows the create-eth extension docs
(`docs.scaffoldeth.io/extensions/createExtensions`):

```
extension/
  README.md.args.mjs                          appended to the new project's README
  AGENTS.md.args.mjs                          adds a Sato Kit section (incl. what it does NOT do) to AGENTS.md
  packages/nextjs/
    package.json                              adds @satohub/kit (merged into SE-2's package.json)
    policy.json                               sato.policy/v1, network "fork", unknown_verdict "refuse"
    app/sato-swap/page.tsx                    the page
    app/api/sato/prepare/route.ts             server route: quote / prepare, no signer
    hooks/sato/useGuardedSwap.ts              prepare → review → wallet signs
    utils/sato/guardedSwap.ts                 server: builds a kit with swap.quote + swap.prepare only
    utils/sato/walletTx.ts                    browser side: turns a reviewed intent into a wallet request
    components/Header.tsx.args.mjs            adds the "Guarded swap" menu link
```

`utils/sato/*.ts` is typechecked against the local kit (`channels/tsconfig.json`), and
`channels/test/channels.test.mjs` runs `walletTxFor` and `prepareGuardedSwap` against recorded
fixtures: a refused intent, a failed simulation and an expired intent are never turned into a
wallet request.

## Local test with create-eth (keyless)

From the create-eth docs, with this extension copied into `create-eth/externalExtensions/`:

```bash
git clone https://github.com/scaffold-eth/create-eth.git && cd create-eth
yarn install && yarn build:dev
mkdir -p externalExtensions && cp -R <this repo>/channels/scaffold-eth-extension externalExtensions/sato-kit
yarn cli ../sato-se2-test -e sato-kit --dev
```

See `README.md` in `channels/` for what was run and what it showed.

## How it gets listed

create-eth lists third-party extensions in `src/extensions/organizations.ts` (entries such as
MetaMask's and SIWE's). An entry is `{ extensionFlagValue: "<org>/<repo>", name, description,
repository }`. The owner:

1. Publishes this directory as its own public repo, e.g. `satohubai/scaffold-sato-kit-ext`, with the
   `extension/` folder at the repo root (users then run `npx create-eth@latest -e satohubai/scaffold-sato-kit-ext`).
2. After `@satohub/kit` is on npm and the extension installs cleanly, opens a PR on
   `scaffold-eth/create-eth` adding one entry to `organizations.ts`:

```ts
{
  extensionFlagValue: "satohubai/scaffold-sato-kit-ext",
  name: "Sato Kit guarded swap",
  description: "Adds the Sato Kit and a swap page that prepares, checks against your policy file and simulates a swap before your wallet signs it.",
  repository: "https://github.com/satohubai/scaffold-sato-kit-ext",
},
```
