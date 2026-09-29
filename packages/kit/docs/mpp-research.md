# mpp.prepare — research note (not implemented)

Scope row K1 names `mpp_prepare` (a thin wrapper over `mppx`, modelled on
`x402.prepare`). This note records why the kit does **not** ship it yet, and
what would change that. Checked 2026-09-29.

## What MPP is

The Machine Payments Protocol is an HTTP `402 Payment Required` flow
co-authored by Tempo and Stripe: the server answers with a
`WWW-Authenticate: Payment` challenge, the client fulfils it with a payment
method, and retries with `Authorization: Payment <credential>`.

- Core spec: IETF individual draft `draft-ryan-httpauth-payment`
  (https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/)
- Rendered spec incl. methods and extensions: https://paymentauth.org/
- Spec repo: https://github.com/tempoxyz/mpp-specs
- TypeScript SDK: `mppx` (https://github.com/wevm/mppx, docs
  https://mpp.dev/sdk/typescript)

## Why nothing is implemented

The task rule is: implement only if a stable, documented client exists.
`mppx` is documented, but it is not stable yet:

1. **Pre-1.0 with breaking minors.** npm shows 0.11.0 as current, with
   0.9.0, 0.10.0 and 0.11.0 all published within four weeks. Its CHANGELOG
   marks breaking changes in minors: 0.10.0 requires the primary recipient
   in `expectedRecipients` ("Configurations containing only split
   recipients are now rejected"); 0.11.0 removed the `memo` charge option.
   A wrapper pinned today would be a migration next month.
2. **The core spec is an individual IETF draft**, not an adopted working
   group document, so the challenge/credential shape can still change.
3. **The payment methods do not map onto an unsigned object.** The kit's
   `prepare` must return something the kit's own signer executes once, after
   the policy pre-flight. The quick-start client method is `tempo` (Tempo
   chain, not in the kit's chain set); the `stripe` method uses a Stripe
   shared payment token, which the kit's signers do not hold; the `evm` and
   `x402` methods would overlap with `x402.prepare`, which already exists.
   `mppx`'s client pays inside `fetch` with an account it holds. A
   preparation hook (`prepareRequest`) arrived in 0.10.0 and its default
   behaviour changed again in 0.10.1, so it is not yet a surface to pin a
   "build the payment, do not send it" wrapper on.
4. **Peer weight.** `mppx` peers on hono, next, express, elysia, several
   `@x402/*` packages and the MCP SDK; even optional, that is a large surface
   for one read-only step.

## What a thin wrapper would look like once it is stable

Modelled on `x402.prepare`: fetch the resource, parse the
`WWW-Authenticate: Payment` challenge, and return — without paying —
the amount, currency, recipient(s), method and expiry, with refusals named by
rule (`max_usd_per_trade`, `recipient_allowlist`, `unknown_price`,
`intent_ttl`, method not supported). Execution would be added only for a
method whose payment is one unsigned EVM transaction on a chain the kit
supports, so it goes through simulate → pre-flight → execute like any other
intent.

## Revisit when

- `mppx` publishes 1.0 (or states a stability policy for the client API), or
- the challenge format is adopted by an IETF working group, or
- a payment method whose credential is a single EVM transaction on a kit
  chain is documented in paymentauth.org.
