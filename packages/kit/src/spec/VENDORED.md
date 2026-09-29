# Vendored: ODA contracts (`sato.action/v1` and friends)

Source: `amateokap/onchain-agent` (private), path `lib/oda/*`, branch `claude/oda-typed-data-signature`,
commit `60282a319c10585373098294231aa820a84274f7` (Phase 2 wave 3: optional receipt field
`typed_data_signature`, `TYPED_DATA_SIGNATURE_RE`).
Previously `claude/oda-typed-data-solana` at `1a356bbe52383464c7687e8aabce7d4c547a8d52` (wave 2: `typed_data`
and `solana_tx` payload kinds, `safe_tx_hash` / `signature`, `validateUnsignedPayload`), and before that
`claude/m0-contracts` at `94d7c8f195fa028fbea42159d00d84f8743ae78a`.

Copied verbatim with ONE mechanical transform: relative import specifiers gained a
`.js` suffix (`"./canonical"` -> `"./canonical.js"`), which Node ESM / `moduleResolution: NodeNext`
requires. No other byte changed. Do not edit here: change the source, then re-vendor.

## Re-vendor note: `policy.ts` (2026-09-28)

`policy.ts` was re-copied from the app's `lib/oda/policy.ts` after it gained the optional `scan` block
(`sato.policy/v1` additive: `SCAN_POLICY_DEFAULTS`, `SCAN_POLICY_KEYS`, `scan?: ScanPolicy` on `SatoPolicy`,
`"scan"` in the closed `POLICY_KEYS`, validated by `parsePolicyFile`). The file has no relative imports, so it is
byte-identical to the source. `scan` is not part of `policyDigest`. Other files in this directory are unchanged.
The kit rebuilds and templates that vendor `@satohub/kit` need a new build to carry it.

## Re-vendor note: `policy.ts` (2026-09-28, second copy)

`policy.ts` was re-copied again after the app's `lib/oda/policy.ts` changed two doc comments only: `payto_changed` now reads
"recorded in the file; enforced only by hosts that implement it" (the kit and the offline guard in `satohub-core` do not
enforce it today), and `hosted_check` no longer says "reserved". No code, type or validation changed. The change to
`lib/oda/policy.ts` since the last vendored release is the `scan` block plus these comments, and both are needed. Still
byte-identical to the source (checked with `cmp`); the file has no relative imports.
