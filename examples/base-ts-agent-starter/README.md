# Base TypeScript agent starter

The smallest TypeScript agent on Base that does all four of these:

1. **Checks its own dependencies with Sato Hub Preflight before installing them.**
2. **Reads market data from Base**: block, gas price and the Chainlink ETH/USD feed, over a public RPC.
3. **Runs every intent past a spending policy** before acting. Allowed actions are `read` and `quote`. Tokens are limited to USDC and WETH on Base, and a quote is capped at 25 USD.
4. **Asks for a swap quote** (USDC → WETH) and reports it: the venue, the quoted output, the implied price against the feed, the response signature and the fee disclosure word for word.

No API key, no account, no wallet, no secrets. It runs as-is in a clean container.

## What it does NOT do

- **It holds no private key.** The wallet in `src/policy.ts` has no `sign` or `broadcast` method. `sign` is refused by the policy and cannot happen in code either.
- **It never builds, signs or sends a transaction.** The quote request sends no `taker`, so Sato Hub builds no transaction and returns `tx: null`. The code stops if one ever comes back.
- **It does not trade and does not move funds.** A quote is not a fill. Prices move between the quote and any trade you make later.
- **Preflight is not a security review.** It reports what Sato Hub has on record about a package and when it was checked. `unknown` means no record. That is not a pass and not a fail. On 2026-09-24 all five of this starter's dependencies came back `unknown`, because Sato Hub lists agent tooling, not general npm packages.
- **The pre-install check does not verify the response signature.** The verifier, `satohub-core`, is one of the packages being checked. The swap quote is verified after install.
- **The policy runs in this process.** Anyone who can edit the process can edit the policy. That is fine for a starter that cannot sign. It is not enough for a wallet that can.

## Run it

Node 20 or newer.

```sh
npm run setup      # Preflight on package.json, then npm install (stops on a "no" verdict)
npm start          # one pass: policy → market → policy checks → quote → report
npm run typecheck
```

`npm run setup` needs nothing installed. It is a zero-dependency script (`scripts/preflight-deps.mjs`) followed by `npm install`. To make `caution` block the install as well, run `node scripts/preflight-deps.mjs --fail-on caution`.

In a clean container, the way it was tested:

```sh
docker run --rm -v "$PWD":/src:ro node:22-bookworm-slim \
  sh -c 'cp -r /src /app && cd /app && npm run setup && npm run typecheck && npm start'
```

| Variable | Default | |
|---|---|---|
| `BASE_RPC_URL` | `https://mainnet.base.org` | any Base mainnet RPC |
| `AMOUNT_USDC` | `10` | quote size. Above 25 the policy refuses it (`P4-size`) |
| `SATO_USER_AGENT` | `base-ts-agent-starter/0.1` | please set your own |

## Output of a clean-container run (2026-09-24, node:22-bookworm-slim)

```text
Policy checks
  sign a transaction refused P1-action (limit read,quote, saw sign)
  quote 1000 USDC    refused P4-size (limit <= 25 USD, saw 1000)
  quote 10 USDC      allowed

Swap quote (unsigned — no transaction was built)
  venue              KyberSwap — https://satohub.ai/resources/kyberswap
  venue preflight    caution (rule R6) — what is on record, not a review
  in                 10 USDC
  out (quoted)       0.00370813 WETH
  implied ETH/USD    2696.77 (+0.05% vs the Chainlink feed, fee included)
  signature          verified (kid b04bd38b, signed 2026-09-25T00:16:55.694Z)

Done. Nothing was signed, sent or spent.
```

## The fee, stated plainly

The quote comes from Sato Route (`GET https://satohub.ai/api/route/swap`, through `satohub-core`). If you later build and sign a transaction from a Sato Route route, Sato Route takes a fee inside that transaction: 15 bps when either side is a volatile token (as with USDC → WETH), 3 bps stable-to-stable, 25 bps cross-chain. The quoted output already has the fee deducted. This starter never builds that transaction, so running it costs nothing. The full disclosure is printed word for word on every run. If you want a quote with no Sato fee, call a venue's own quote API instead.

## From starter to agent

The parts you would change, in order:

- **Signing.** Swap `PolicyWallet` for a signer that enforces its policy on the server that holds the key, not in this process. For this build goal ("TypeScript onchain agent on Base with a policy-controlled wallet, swaps"), Sato Hub's `recommend_stack` and `build_plan` both put [Turnkey](https://satohub.ai/resources/turnkey) and [Privy](https://satohub.ai/resources/privy) in the wallet slot on 2026-09-24. Both have installs Sato Hub reproduced in a container. That is a record, not an endorsement. Run Preflight on whichever you pick.
- **Execution.** Sending a `taker` to Sato Route returns an unsigned transaction. Simulate it, sign it with your signer, and check the fee disclosure again before you sign.
- **A loop.** This file runs one pass. An agent runs it on a schedule and keeps state between passes.

## Files

| | |
|---|---|
| `scripts/preflight-deps.mjs` | Preflight on `package.json` before install. Zero dependencies |
| `src/policy.ts` | the policy, `evaluate()`, and the key-less `PolicyWallet` |
| `src/market.ts` | read-only Base reads with viem |
| `src/agent.ts` | one pass, start to finish |

MIT.
