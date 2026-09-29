// generated, do not edit
// Source: lib/stablecoins.ts and lib/scan/skeleton.ts in the Sato Hub app.
// Regenerate there with: npx tsx scripts/gen-core-scan-table.mjs --out <this file>
//
// WHAT THIS IS. Which contract address (EVM) or mint (Solana) each stablecoin issuer names
// for its token on each chain, plus the letter map used to fold a token label. It is a record
// of what an issuer or chain document points to on the as-of date. It is not a safety claim,
// an audit or a "trusted list", and no entry says anything about price or reserves.
// Addresses: EVM lowercase; Solana base58 exactly as issued (case-sensitive).

/** The date every row below was last reconciled with its source. */
export const SCAN_TABLE_AS_OF = "2026-09-28";

/** sha256 of the table data (see scripts/gen-core-scan-table.mjs `dataString`); a mismatch means drift. */
export const SCAN_TABLE_SHA256 = "7faf64127ce27659cd709f7df37b96f96880215b6a93fca19bb6d0146f4e434c";

export type ScanTableKind = "issuer" | "bridged" | "peg";

/** [chain, address, family, symbol, kind] */
export type ScanTableRow = readonly [chain: string, address: string, family: string, symbol: string, kind: ScanTableKind];

export const SCAN_STABLES: readonly ScanTableRow[] = [
  ["Base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "USDC", "USDC", "issuer"],
  ["Base", "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", "EURC", "EURC", "issuer"],
  ["Solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC", "USDC", "issuer"],
  ["Solana", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT", "USDT", "issuer"],
  ["Solana", "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", "EURC", "EURC", "issuer"],
  ["Solana", "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "PYUSD", "PYUSD", "issuer"],
  ["Solana", "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", "USDG", "USDG", "issuer"],
  ["Polygon", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "USDC", "USDC", "issuer"],
  ["Polygon", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", "USDT", "USDT0", "issuer"],
  ["Polygon", "0x99af3eea856556646c98c8b9b2548fe815240750", "PYUSD", "PYUSD", "issuer"],
  ["Arbitrum", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "USDC", "USDC", "issuer"],
  ["Arbitrum", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "USDT", "USDT0", "issuer"],
  ["Arbitrum", "0x46850ad61c2b7d64d08c9c754f45254596696984", "PYUSD", "PYUSD", "issuer"],
  ["Arbitrum", "0x004b506865409877c9fa29bfb1eba929984b9bbc", "USDG", "USDG", "issuer"],
  ["Avalanche", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", "USDC", "USDC", "issuer"],
  ["Avalanche", "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", "USDT", "USDT", "issuer"],
  ["Avalanche", "0xc891eb4cbdeff6e073e859e987815ed1505c2acd", "EURC", "EURC", "issuer"],
  ["Optimism", "0x0b2c639c533813f4aa9d7837caf62653d097ff85", "USDC", "USDC", "issuer"],
  ["Optimism", "0x01bff41798a0bcf287b996046ca68b395dbc1071", "USDT", "USDT0", "issuer"],
  ["Sei", "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392", "USDC", "USDC", "issuer"],
  ["Sei", "0x9151434b16b9763660705744891fa906f660ecc5", "USDT", "USDT0", "issuer"],
  ["X Layer", "0xb6ceceab302e2e4948951ee7843fc24e92933061", "USDC", "USDC", "issuer"],
  ["X Layer", "0x779ded0c9e1022225f8e0630b35a9b54be713736", "USDT", "USDT0", "issuer"],
  ["X Layer", "0x87b4a8176b3df6b71e26cc095edcaf4db07506b4", "PYUSD", "PYUSD", "issuer"],
  ["X Layer", "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", "USDG", "USDG", "issuer"],
  ["Monad", "0x754704bc059f8c67012fed69bc8a327a5aafb603", "USDC", "USDC", "issuer"],
  ["Monad", "0xe7cd86e13ac4309349f30b3435a9d337750fc82d", "USDT", "USDT0", "issuer"],
  ["World Chain", "0x79a02482a880bce3f13e09da970dc34db4cd24d1", "USDC", "USDC", "issuer"],
  ["World Chain", "0x1c60ba0a0ed1019e8eb035e6daf4155a5ce2380b", "EURC", "EURC", "issuer"],
  ["Polygon", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "USDC", "USDC", "bridged"],
  ["Arbitrum", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "USDC", "USDC", "bridged"],
  ["Optimism", "0x7f5c764cbc14f9669b88837ca1490cca17c31607", "USDC", "USDC", "bridged"],
  ["Base", "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", "USDC", "USDbC", "bridged"],
  ["Ethereum", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "USDC", "USDC", "issuer"],
  ["Ethereum", "0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT", "USDT", "issuer"],
  ["Ethereum", "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", "EURC", "EURC", "issuer"],
  ["Ethereum", "0x6c3ea9036406852006290770bedfcaba0e23a0e8", "PYUSD", "PYUSD", "issuer"],
  ["Ethereum", "0xe343167631d89b6ffc58b88d6b7fb0228795491d", "USDG", "USDG", "issuer"],
  ["Robinhood Chain", "0x5fc5360d0400a0fd4f2af552add042d716f1d168", "USDG", "USDG", "issuer"],
  ["Tempo", "0x20c0000000000000000000000000000000000000", "pathUSD", "pathUSD", "issuer"],
  ["Tempo", "0x20c00000000000000000000014f22ca97301eb73", "USDT", "USDT0", "issuer"],
  ["Tempo", "0x20c000000000000000000000b9537d11c60e8b50", "USDC", "USDC.e", "bridged"],
  ["BNB Chain", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "USDC", "USDC", "peg"],
  ["SKALE Base", "0x85889c8c714505e0c94b30fcfcf64fe3ac8fcb20", "USDC", "USDC.e", "bridged"],
  ["Abstract", "0x84a71ccd554cc1b02749b35d22f684cc8ec987e1", "USDC", "USDC.e", "bridged"],
];

/** [look-alike letter, the ASCII letter it imitates], keys sorted by code point. */
export const SCAN_CONFUSABLES: readonly (readonly [string, string])[] = [
  ["Đ", "D"],
  ["đ", "D"],
  ["Ɖ", "D"],
  ["ɢ", "G"],
  ["ʀ", "R"],
  ["ʏ", "Y"],
  ["ʙ", "B"],
  ["ʜ", "H"],
  ["Α", "A"],
  ["Β", "B"],
  ["Ε", "E"],
  ["Η", "H"],
  ["Ο", "O"],
  ["Ρ", "P"],
  ["Τ", "T"],
  ["Υ", "Y"],
  ["ο", "O"],
  ["ρ", "P"],
  ["υ", "U"],
  ["Ѕ", "S"],
  ["А", "A"],
  ["В", "B"],
  ["Е", "E"],
  ["Н", "H"],
  ["О", "O"],
  ["Р", "P"],
  ["С", "C"],
  ["Т", "T"],
  ["У", "Y"],
  ["а", "A"],
  ["е", "E"],
  ["о", "O"],
  ["р", "P"],
  ["с", "C"],
  ["у", "Y"],
  ["ѕ", "S"],
  ["Ү", "Y"],
  ["ү", "Y"],
  ["Ԁ", "D"],
  ["ԁ", "D"],
  ["ԍ", "G"],
  ["Ս", "U"],
  ["Օ", "O"],
  ["ս", "U"],
  ["Ⴝ", "S"],
  ["Ꭰ", "D"],
  ["Ꭱ", "R"],
  ["Ꭲ", "T"],
  ["Ꭹ", "Y"],
  ["Ꭺ", "A"],
  ["Ꭼ", "E"],
  ["Ꮃ", "W"],
  ["Ꮇ", "M"],
  ["Ꮋ", "H"],
  ["Ꮐ", "G"],
  ["Ꮢ", "R"],
  ["Ꮪ", "S"],
  ["Ꮯ", "C"],
  ["Ꮲ", "P"],
  ["Ᏼ", "B"],
  ["ᴀ", "A"],
  ["ᴄ", "C"],
  ["ᴅ", "D"],
  ["ᴇ", "E"],
  ["ᴏ", "O"],
  ["ᴘ", "P"],
  ["ᴛ", "T"],
  ["ᴜ", "U"],
  ["₮", "T"],
  ["₵", "C"],
  ["Ⲥ", "C"],
  ["ⲥ", "C"],
  ["ꓐ", "B"],
  ["ꓑ", "P"],
  ["ꓓ", "D"],
  ["ꓔ", "T"],
  ["ꓖ", "G"],
  ["ꓚ", "C"],
  ["ꓢ", "S"],
  ["ꓦ", "H"],
  ["ꓬ", "Y"],
  ["ꓮ", "A"],
  ["ꓰ", "E"],
  ["ꓳ", "O"],
  ["ꓴ", "U"],
  ["ꜱ", "S"],
];

/** [code point NFKC would rewrite into a different letter, the ASCII letter to use instead], mapped before NFKC. */
export const SCAN_PRE_NFKC: readonly (readonly [string, string])[] = [
  ["ϲ", "C"],
  ["Ϲ", "C"],
];

/** [stablecoin family, regular-expression source matched against a folded, alphanumeric-only label]. */
export const SCAN_FAMILY_FORMS: readonly (readonly [string, string])[] = [
  ["USDC", "^(USDC|USDCE|USDBC|USDCOIN|USDCOINE|CIRCLEUSDC)$"],
  ["USDT", "^(USDT|USDT0|USDTE|TETHER|TETHERUSD|TETHERUSDT|USDTETHER)$"],
  ["EURC", "^(EURC|EURCE|EUROCOIN)$"],
  ["PYUSD", "^(PYUSD|PAYPALUSD)$"],
  ["USDG", "^(USDG|GLOBALDOLLAR)$"],
  ["pathUSD", "^(PATHUSD)$"],
];
