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
