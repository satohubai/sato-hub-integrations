# Changelog — create-sato-agent

## 0.1.1

Release date: 2026-10-09.

- `--chain solana` is accepted and sent to `POST /api/create`; a Solana goal gets the `solana-guarded-swapper` template
  (simulates every transaction, stops at an unsigned one, `npm run preflight` reads Sato Hub's build receipts from Solana).
- `--offline` copies templates pinned at the commit that adds `solana-guarded-swapper` (nightly green).

## 0.1.0 — first release

Release date: 2026-09-29.

- `npm create sato-agent` / `npx create-sato-agent`: sends a plain-words goal to
  `POST https://satohub.ai/api/create` to choose a template from `satohubai/sato-agent-templates`,
  writes it into a new directory, runs `npm ci` and makes a first git commit.
- Flags: `--framework`, `--chain`, `--network` (default `fork`; `--yes` never enables mainnet),
  `--template`, `--dir`, `--yes`, `--no-install`, `--no-git`, `--offline`.
- `--offline` copies the template at the pinned commit (`TEMPLATES_SHA`) without a server plan or
  signed manifest.
