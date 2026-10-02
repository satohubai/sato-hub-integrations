# Channel drafts (not submitted)

Drafts for placing the Sato Kit (`@satohub/kit`) in other projects' channels, in order of how
realistic each is. **Nothing in this folder has been published, submitted or opened as a PR
anywhere.** Every submission below is a step the owner takes, from the account named.

## Before any of these: what must be true

1. **`@satohub/kit@0.1.1` is on npm.** Every draft installs or runs it by that exact version;
   today `npm view @satohub/kit` returns 404. The owner publishes it from `packages/kit`
   (see `PUBLISHING.md`).
2. **It has been on npm for at least 7 days before the Scaffold-ETH extension is announced.**
   Scaffold-ETH 2 projects ship `npmMinimalAgeGate: 7d` in `.yarnrc.yml`; a fresh project refused
   `@modelcontextprotocol/sdk@1.30.1` (a kit dependency) as "quarantined" in our local run. The
   same gate applies to the kit itself and to `zod@4.6.5`.
3. `satohubai/sato-hub-integrations` stays public (the skill registries and the Base plugin link
   read it). It is public today.
4. The kit's `npm test` and this folder's tests are green on `main`.

## 1. Base MCP plugin spec — `base-mcp/`

- **What:** `sato-kit.md`, a `cli-only` Base MCP plugin: the agent runs the kit's `prepare`
  (policy pre-flight + simulation) through the CLI and submits the unsigned calldata to Base MCP
  `send_calls`, where the user approves it in Base Account. Written to
  `skills/base-mcp/references/plugin-spec.md` in `base/skills`; the test asserts the frontmatter,
  the pinned version and the section order.
- **Where it goes:** `base/skills`, file `skills/base-mcp/plugins/sato-kit.md`.
- **Submission path, as it stands:** `base/skills` `CONTRIBUTING.md` says contributions are
  currently limited to the Base core team, even though the spec describes third-party PRs. So:
  1. Owner (as Sato Hub, `satohubai` GitHub account) asks the Base team whether they accept a
     third-party plugin now, and in what form (issue on `base/skills`, or their developer contact).
     Do not open a PR before they say yes.
  2. If yes: fork `base/skills`, add only `skills/base-mcp/plugins/sato-kit.md` (plus the new tag
     `policy` to the vocabulary list in `plugin-spec.md`), run their `/plugin-review` skill, open
     the PR from `satohubai`.
  3. Meanwhile the file works as a custom plugin: a user can load it next to the Base MCP skill.
- **Status 2026-10-02: shipped as a custom plugin, not submitted.** Outside plugin PRs have gone
  unanswered since late June (17 open, none merged), so the plugin is offered self-serve. The steps
  are in the kit README, section "Use with Base MCP". The server URL is now
  `https://wallet-mcp.coinbase.com`, and the skill id stays `base-mcp`. Details:
  `base-mcp/README.md`.

## 2. Scaffold-ETH 2 extension — `scaffold-eth-extension/`

- **What:** a create-eth extension that adds `@satohub/kit` to `packages/nextjs`, a server route
  that prepares one swap with no signer, a `useGuardedSwap` hook, a **Guarded swap** page, a menu
  link, and README/AGENTS.md sections (including what it does NOT do). Only an intent that passed
  the pre-flight, simulated successfully and has not expired can be sent to the connected wallet.
- **Verified here (keyless):** create-eth's documented local test —
  `yarn build:dev`, extension copied to `externalExtensions/sato-kit`,
  `yarn cli ../sato-se2-test -e sato-kit --dev --skip-install -s none` — generated a project with
  the page, route, hook, utils, menu link, README and AGENTS.md sections and the `@satohub/kit`
  dependency merged. Then, with the dependency pointed at a packed build of the local kit
  (`npm pack`) and the age gate bypassed for that run only, `yarn install`, `tsc --noEmit` and the
  project's own ESLint + Prettier config passed on the extension's files. No dev server was run.
- **Where it goes:** its own public repo (suggested `satohubai/scaffold-sato-kit-ext`, with
  `extension/` at the root), then one entry in `scaffold-eth/create-eth`
  `src/extensions/organizations.ts` (text in `scaffold-eth-extension/README.md`).
- **Owner steps:** (1) after requirement 1 and 2 above, create the repo from `satohubai` and push
  this folder's contents; (2) run `npx create-eth@latest -e satohubai/scaffold-sato-kit-ext` once
  on a clean machine; (3) open the `organizations.ts` PR on `scaffold-eth/create-eth` from
  `satohubai`.

## 3. skills.sh and ClawHub — `skills/`

- **What:** exact listing fields for the kit's skill (`packages/kit/skill/SKILL.md`), and a
  generated ClawHub copy (`skills/clawhub/sato-kit/SKILL.md`) with ClawHub's two frontmatter
  requirements (top-level `version`, no `license:` line). The test fails if the copy drifts.
- **Where it goes / owner steps:** in `skills/README.md` — ClawHub via
  `clawhub publish … --slug sato-kit --owner satohubai` signed in as `satohubai` (dry-run first);
  skills.sh has no submission, it lists what `npx skills add satohubai/sato-hub-integrations
  --skill sato-kit` installs.

## 4. Cloudflare Agents x402 example — `cloudflare-agents-x402/`

- **What:** a server-only Cloudflare Agents example: `PayAgent.fetchPaid(url, max)` runs the kit's
  `x402.prepare` pre-flight against `src/policy.json` (testnet, `base-sepolia`, USD caps, unknown
  price refused) and, only if it passes, pays with `@x402/fetch` while an x402 client
  `registerPolicy` filter limits payment to the approved requirement.
- **Verified here:** `src/guard.ts` typechecked and tested offline (approve inside budget, refuse
  over budget and over the USD cap, filter drops any changed requirement). The whole example,
  `src/index.ts` included, passed `tsc --noEmit` against `agents@0.24.0`,
  `@cloudflare/workers-types`, `@x402/*@2.17.0` and a packed build of the kit. Not deployed.
- **Where it goes:** `cloudflare/agents`, as `examples/x402-budget/` (their `examples/AGENTS.md`
  describes the server-only layout this follows). Owner: ask in the repo (issue) whether they
  take a third-party example; if yes, fork and PR from `satohubai`. Otherwise publish it as a
  standalone repo and link it from the kit README.

## 5. AgentKit examples PR — `agentkit-example/`

- **What:** `typescript/examples/langchain-sato-kit-chatbot/`, laid out exactly as it would land
  in `coinbase/agentkit` (mirrors `langchain-cdp-chatbot`), plus `PR.md`, the PR body written to
  their template. Chat mode only; every signature needs a `y` at the terminal.
- **Verified here:** `sato.ts` typechecked against the local kit and `@coinbase/agentkit@0.10.4`,
  and its signer tested offline (a chain-id mismatch is refused; the exact `to`/`data`/`value` is
  passed through). `chatbot.ts` compiles against npm packages except for one error that comes from
  the published `@coinbase/agentkit-langchain@0.3.0` still depending on `@langchain/core` 0.3 while
  `langchain` 1.x uses core 1.x; inside the AgentKit monorepo the example uses the workspace
  packages, like the existing chatbot examples. Run `pnpm lint` there before opening the PR.
- **Where it goes / owner steps:** fork `coinbase/agentkit` as `satohubai`, copy
  `agentkit-example/typescript` over the fork root, `pnpm install && pnpm build`, test on Base
  Sepolia and paste the transcript into `PR.md`'s Tests section, sign the commits (the repo
  requires signed commits), open the PR. Least likely to merge of the five; submit last.

## Tests

`channels/` is an npm workspace. `npm test` at the repo root runs its tests after the build:
banned wording, pinned versions, valid `sato.policy/v1` files (never `mainnet`, unknown price
refused), the Base plugin's shape, the ClawHub copy, the extension layout, and the example code
against recorded fixtures (no network, no model, no keys). `npm run typecheck` typechecks the
example code against the local kit through the workspace link.
