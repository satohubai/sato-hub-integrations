# Changelog

## 0.1.0 — 2026-09-23

First release.

- `SatohubActionProvider` / `satohubActionProvider()`: a Coinbase AgentKit
  action provider with two read-only, keyless actions.
  - `preflight`: `{ targetType: repo | package | endpoint | agent | token | skill, target, chain }`
    → the verdict, the rule, what the verdict means, one evidence line per
    check (field and time), the target with its citation URLs, and the
    signature state.
  - `search_resources`: `{ query, chain, limit }` → matching listings with
    Sato Score, tier, liveness, verification status and citation URL.
- Requests go through `satohub-core`, so Preflight signatures are verified
  before a verdict is read.
- Failures (network, timeout, HTTP, malformed body, signature mismatch) return
  `success: false` with no `verdict`, never `unknown`.
- Third-party strings are stripped of invisible characters and
  length-bounded; non-http(s) URLs and `utm_*` parameters are dropped.
- Peer dependencies: `@coinbase/agentkit` ^0.10.0, `zod` ^3.23.0.
