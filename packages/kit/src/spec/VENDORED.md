# Vendored: ODA contracts (`sato.action/v1` and friends)

Source: Sato Hub app (private), path `lib/oda/*`, branch `claude/oda-typed-data-solana`,
commit `1a356bbe52383464c7687e8aabce7d4c547a8d52` (Phase 2 wave 2: additive `typed_data` and
`solana_tx` payload kinds, optional receipt fields `safe_tx_hash` / `signature`, `validateUnsignedPayload`).
Previously `claude/m0-contracts` at `94d7c8f195fa028fbea42159d00d84f8743ae78a`.

Copied verbatim with ONE mechanical transform: relative import specifiers gained a
`.js` suffix (`"./canonical"` -> `"./canonical.js"`), which Node ESM / `moduleResolution: NodeNext`
requires. No other byte changed. Do not edit here: change the source, then re-vendor.
