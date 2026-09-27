# x402 payments inside a budget (Cloudflare Agents + Sato Kit) — draft, not submitted

A server-only Cloudflare Agents example: an Agent pays for an x402 resource only after the
[Sato Kit](https://github.com/satohubai/sato-hub-integrations/tree/main/packages/kit) pre-flight
approves the payment against a policy file, and the x402 client is then limited to exactly the
requirement that was approved.

It follows the shape of the Agents SDK's own `examples/x402` (Hono Worker, an `Agent` with a
`@callable()` method, `@x402/fetch`) and the server-only layout in `examples/AGENTS.md`
(`package.json`, `wrangler.jsonc`, `tsconfig.json` extending `agents/tsconfig`, `README.md`,
`src/`).

## What it demonstrates

- **`x402.prepare` as a gate.** `preflightPayment()` (in `src/guard.ts`) fetches the resource,
  reads the 402's requirements, and checks the first acceptable one against `src/policy.json`:
  network (`testnet`), chain allowlist (`base-sepolia`), per-trade and per-day USD caps, and
  `unknown_verdict: "refuse"` for an asset it cannot price. A refusal returns each rule with its
  limit and observed value, and nothing is signed.
- **`registerPolicy` binds the payment to the pre-flight.** `onlyApprovedRequirement()` is an
  x402 client `PaymentPolicy` that keeps only the requirement with the approved network, asset,
  recipient and amount. If the server changes its terms between the check and the payment, the
  client has nothing left to pay.

## What it does NOT do

- It does not enforce anything once a key is in play. The pre-flight explains refusals before a
  signature; the key (here a test key in `CLIENT_TEST_PK`) and any limits a signer applies are
  what enforce.
- It does not run on mainnet: the policy says `testnet` and allows `base-sepolia` only.
- It does not keep a receipt log across requests: the kit here uses in-memory stores, so the
  per-day cap counts only payments made through the same kit instance.
- It does not choose what to buy. The caller passes the URL and the most it will pay.

## Running

```sh
cp .env.example .dev.vars     # CLIENT_TEST_PK = a Base Sepolia test key, never a funded key
npm install
npm start
```

Then call `fetchPaid(url, maxAmountBaseUnits)` on the `PayAgent` from any Agents client
(`useAgent` + `agent.call("fetchPaid", [url, "100000"])`).

## Verification done in this repo

- `src/guard.ts` is typechecked against the local kit and tested offline (`channels/test`):
  a requirement over budget is refused with its rules, and `onlyApprovedRequirement` drops any
  requirement whose recipient, asset, network or amount differs from the approved one.
- The whole example (`src/index.ts` included) was typechecked with `tsc --noEmit` against
  `agents`, `@cloudflare/workers-types`, `@x402/*` and a packed build of the local kit. It was
  not deployed.
