# Changelog — create-sato-agent

## 0.1.0 — first release

Release date: 2026-09-29.

- `npm create sato-agent` / `npx create-sato-agent`: sends a plain-words goal to
  `POST https://satohub.ai/api/create` to choose a template from `satohubai/sato-agent-templates`,
  writes it into a new directory, runs `npm ci` and makes a first git commit.
- Flags: `--framework`, `--chain`, `--network` (default `fork`; `--yes` never enables mainnet),
  `--template`, `--dir`, `--yes`, `--no-install`, `--no-git`, `--offline`.
- `--offline` copies the template at the pinned commit (`TEMPLATES_SHA`) without a server plan or
  signed manifest.
