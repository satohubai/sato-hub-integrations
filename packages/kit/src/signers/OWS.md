# Open Wallet Standard (OWS) — signer research, 2026-09-26

**Finding:** OWS is a good signer for real keys, but the kit does not import it. `ows.ts` is a structural adapter over an OWS-backed viem account that you pass in. `viemLocalSigner` is the fork-mode default.

## What OWS is (checked with `npm view` on 2026-09-26)

- Package: `@open-wallet-standard/core` 1.4.2 (published 2026-06-19, first published 2026-03-13), maintainer `moonpay-engineering`.
- License: MIT (package metadata and README badge pointing to `github.com/open-wallet-standard/core/blob/main/LICENSE`).
- Repo: https://github.com/open-wallet-standard/core · docs: https://openwallet.sh
- Adapters: `@open-wallet-standard/adapters` 1.4.2. `@open-wallet-standard/adapters/viem` exports `owsToViemAccount(walletName, { chain, passphrase, index, vaultPath })`, which returns a viem `Account` that signs through OWS.
- Core API (README): `createWallet(name)`, `signMessage(name, chain, msg)`, plus a CLI `ows` (wallet, sign, policy create, key create/revoke).
- Model: keys stay encrypted in a local vault (`~/.ows/wallets/`) and are decrypted only inside the OWS signing path. A pre-signing policy engine gates API-key (agent) operations before decryption: chain allowlists, expiry, optional custom executables. The README states the API never returns raw private keys.

## Why the kit does not depend on it

1. **Native addon.** The package "embeds the Rust core via native FFI" and ships prebuilt binaries as optional dependencies for darwin-x64, darwin-arm64, linux-x64-gnu and linux-arm64-gnu only. There is no Windows or musl binary, and a scaffold that fails to install on those hosts is worse than one that asks for a wallet.
2. **Zero runtime dependencies.** `@satohub/kit` has none, and a native addon would be its first.
3. **A vault on disk.** OWS writes to `~/.ows`. A throwaway fork key should not.

## How to use it

```ts
import { owsToViemAccount } from "@open-wallet-standard/adapters/viem";
import { owsSigner } from "@satohub/kit/signers";

const signer = owsSigner({ wallet: owsToViemAccount("agent-wallet", { chain: "eip155:84532" }), rpc });
```

Enforcement lives in OWS (its pre-signing policy). The kit's `policy.json` is a pre-flight that explains refusals. It does not enforce.

## Revisit when

- OWS publishes Windows and musl binaries, or a pure-WASM build, and
- the scaffold (create-sato-agent) wants a local vault by default for testnet. The owner decision in scope §0.1 names OWS as the default local signer. This finding keeps that as the recommended path for real keys, and makes the dependency opt-in.
