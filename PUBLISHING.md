# Publishing

Everything here is gated on an npm login this repo's build agent does not hold; everything short of that is done and checked in.

## Sato Kit 0.1.0 + create-sato-agent 0.1.0 (first release)

Both names are unpublished. Publish the kit first: templates made by
create-sato-agent depend on `@satohub/kit`, and the MCP Registry entry
`ai.satohub/kit` can only be listed once npm serves a `package.json` with
`mcpName`.

### 0. Before you start

```sh
git checkout main && git pull
npm install
npm run build && npm test            # all green on Node 20 and 22 (CI runs both)
cd packages/kit && node scripts/gen-actions-doc.mjs --check && cd ../..   # README table current
npm whoami || npm login              # the Sato Hub npm account; 2FA (auth-and-writes) on
npm org ls satohub 2>/dev/null || true   # @satohub scope must be the account's (it already publishes @satohub/mcp)
```

### 1. `@satohub/kit`

```sh
npm pack --dry-run -w @satohub/kit   # compare with the list below: 316 files, ~243 kB packed
grep '"mcpName"' packages/kit/package.json    # "ai.satohub/kit"
npm publish --access public -w @satohub/kit   # prompts for the 2FA code
```

Expected `npm pack --dry-run` file list (checked on this branch; no `test/`,
fixtures, `scripts/`, `.env*` or `.sato/` in it):

<details><summary>@satohub/kit 0.1.0 — 316 files</summary>

```
504B .claude-plugin/plugin.json
546B .codex-plugin/plugin.json
122B .mcp.json
1.8kB CHANGELOG.md
1.1kB LICENSE
16.0kB README.md
725B context7.json
3.6kB dist/actions/_bridge.d.ts
1.9kB dist/actions/_bridge.d.ts.map
8.8kB dist/actions/_bridge.js
9.0kB dist/actions/_bridge.js.map
4.7kB dist/actions/_solana.d.ts
3.1kB dist/actions/_solana.d.ts.map
8.0kB dist/actions/_solana.js
8.2kB dist/actions/_solana.js.map
1.4kB dist/actions/_swap_input.d.ts
561B dist/actions/_swap_input.d.ts.map
2.9kB dist/actions/_swap_input.js
2.5kB dist/actions/_swap_input.js.map
3.3kB dist/actions/_util.d.ts
2.3kB dist/actions/_util.d.ts.map
5.9kB dist/actions/_util.js
6.3kB dist/actions/_util.js.map
3.1kB dist/actions/_venues.d.ts
2.0kB dist/actions/_venues.d.ts.map
7.5kB dist/actions/_venues.js
8.7kB dist/actions/_venues.js.map
943B dist/actions/bridge_prepare.d.ts
963B dist/actions/bridge_prepare.d.ts.map
9.7kB dist/actions/bridge_prepare.js
7.3kB dist/actions/bridge_prepare.js.map
948B dist/actions/bridge_quote.d.ts
710B dist/actions/bridge_quote.d.ts.map
5.4kB dist/actions/bridge_quote.js
3.6kB dist/actions/bridge_quote.js.map
1.3kB dist/actions/chain_read.d.ts
1.2kB dist/actions/chain_read.d.ts.map
7.0kB dist/actions/chain_read.js
6.0kB dist/actions/chain_read.js.map
1.1kB dist/actions/erc8004_lookup.d.ts
917B dist/actions/erc8004_lookup.d.ts.map
5.7kB dist/actions/erc8004_lookup.js
4.9kB dist/actions/erc8004_lookup.js.map
1.1kB dist/actions/erc8004_register.d.ts
710B dist/actions/erc8004_register.d.ts.map
5.6kB dist/actions/erc8004_register.js
3.9kB dist/actions/erc8004_register.js.map
2.0kB dist/actions/index.d.ts
1.5kB dist/actions/index.d.ts.map
1.8kB dist/actions/index.js
1.3kB dist/actions/index.js.map
290B dist/actions/registry.d.ts
308B dist/actions/registry.d.ts.map
1.3kB dist/actions/registry.js
1.1kB dist/actions/registry.js.map
1.3kB dist/actions/solana_read.d.ts
1.1kB dist/actions/solana_read.d.ts.map
6.3kB dist/actions/solana_read.js
5.8kB dist/actions/solana_read.js.map
2.1kB dist/actions/solana_swap.d.ts
1.7kB dist/actions/solana_swap.d.ts.map
15.3kB dist/actions/solana_swap.js
11.5kB dist/actions/solana_swap.js.map
1.2kB dist/actions/solana_transfer.d.ts
1.1kB dist/actions/solana_transfer.d.ts.map
9.5kB dist/actions/solana_transfer.js
7.4kB dist/actions/solana_transfer.js.map
1.0kB dist/actions/solana.d.ts
778B dist/actions/solana.d.ts.map
936B dist/actions/solana.js
746B dist/actions/solana.js.map
1.9kB dist/actions/swap_prepare.d.ts
1.4kB dist/actions/swap_prepare.d.ts.map
12.8kB dist/actions/swap_prepare.js
10.5kB dist/actions/swap_prepare.js.map
823B dist/actions/swap_quote.d.ts
670B dist/actions/swap_quote.d.ts.map
5.0kB dist/actions/swap_quote.js
3.5kB dist/actions/swap_quote.js.map
1.9kB dist/actions/token_approvals.d.ts
1.5kB dist/actions/token_approvals.d.ts.map
11.5kB dist/actions/token_approvals.js
9.1kB dist/actions/token_approvals.js.map
619B dist/actions/tx_simulate.d.ts
494B dist/actions/tx_simulate.d.ts.map
5.4kB dist/actions/tx_simulate.js
4.8kB dist/actions/tx_simulate.js.map
881B dist/actions/x402_prepare.d.ts
830B dist/actions/x402_prepare.d.ts.map
11.5kB dist/actions/x402_prepare.js
9.9kB dist/actions/x402_prepare.js.map
2.1kB dist/adapters/_dispatch.d.ts
1.6kB dist/adapters/_dispatch.d.ts.map
6.9kB dist/adapters/_dispatch.js
7.0kB dist/adapters/_dispatch.js.map
4.0kB dist/adapters/agentkit-consume.d.ts
2.9kB dist/adapters/agentkit-consume.d.ts.map
24.1kB dist/adapters/agentkit-consume.js
21.2kB dist/adapters/agentkit-consume.js.map
1.2kB dist/adapters/agentkit.d.ts
1.0kB dist/adapters/agentkit.d.ts.map
3.3kB dist/adapters/agentkit.js
2.6kB dist/adapters/agentkit.js.map
712B dist/adapters/ai-sdk.d.ts
672B dist/adapters/ai-sdk.d.ts.map
1.8kB dist/adapters/ai-sdk.js
1.4kB dist/adapters/ai-sdk.js.map
1.6kB dist/adapters/claude-agent-sdk.d.ts
907B dist/adapters/claude-agent-sdk.d.ts.map
3.3kB dist/adapters/claude-agent-sdk.js
2.5kB dist/adapters/claude-agent-sdk.js.map
1.9kB dist/adapters/eliza.d.ts
2.1kB dist/adapters/eliza.d.ts.map
3.8kB dist/adapters/eliza.js
3.0kB dist/adapters/eliza.js.map
929B dist/adapters/langchain.d.ts
823B dist/adapters/langchain.d.ts.map
2.8kB dist/adapters/langchain.js
2.0kB dist/adapters/langchain.js.map
442B dist/adapters/openai-agents.d.ts
479B dist/adapters/openai-agents.d.ts.map
1.8kB dist/adapters/openai-agents.js
1.2kB dist/adapters/openai-agents.js.map
1.8kB dist/cli/drift.d.ts
1.7kB dist/cli/drift.d.ts.map
6.3kB dist/cli/drift.js
6.1kB dist/cli/drift.js.map
117B dist/cli/index.d.ts
195B dist/cli/index.d.ts.map
103B dist/cli/index.js
178B dist/cli/index.js.map
65B dist/cli/main.d.ts
109B dist/cli/main.d.ts.map
516B dist/cli/main.js
814B dist/cli/main.js.map
834B dist/cli/run.d.ts
720B dist/cli/run.d.ts.map
14.9kB dist/cli/run.js
15.7kB dist/cli/run.js.map
1.7kB dist/config/index.d.ts
1.5kB dist/config/index.d.ts.map
6.6kB dist/config/index.js
5.5kB dist/config/index.js.map
1.2kB dist/index.d.ts
984B dist/index.d.ts.map
1.3kB dist/index.js
851B dist/index.js.map
853B dist/intent/hmac.d.ts
577B dist/intent/hmac.d.ts.map
1.6kB dist/intent/hmac.js
1.5kB dist/intent/hmac.js.map
242B dist/intent/index.d.ts
270B dist/intent/index.d.ts.map
240B dist/intent/index.js
268B dist/intent/index.js.map
833B dist/intent/store.d.ts
349B dist/intent/store.d.ts.map
3.9kB dist/intent/store.js
3.8kB dist/intent/store.js.map
1.7kB dist/kit.d.ts
924B dist/kit.d.ts.map
16.1kB dist/kit.js
13.5kB dist/kit.js.map
143B dist/mcp/index.d.ts
194B dist/mcp/index.d.ts.map
93B dist/mcp/index.js
161B dist/mcp/index.js.map
1.6kB dist/mcp/server.d.ts
1.1kB dist/mcp/server.d.ts.map
9.5kB dist/mcp/server.js
9.6kB dist/mcp/server.js.map
2.5kB dist/policy/compile/cdp.d.ts
1.2kB dist/policy/compile/cdp.d.ts.map
2.9kB dist/policy/compile/cdp.js
3.2kB dist/policy/compile/cdp.js.map
3.4kB dist/policy/compile/privy.d.ts
1.3kB dist/policy/compile/privy.d.ts.map
3.0kB dist/policy/compile/privy.js
3.3kB dist/policy/compile/privy.js.map
1.5kB dist/policy/compile/shared.d.ts
1.1kB dist/policy/compile/shared.d.ts.map
7.1kB dist/policy/compile/shared.js
7.4kB dist/policy/compile/shared.js.map
2.5kB dist/policy/compile/turnkey.d.ts
730B dist/policy/compile/turnkey.d.ts.map
2.1kB dist/policy/compile/turnkey.js
2.0kB dist/policy/compile/turnkey.js.map
623B dist/policy/index.d.ts
573B dist/policy/index.d.ts.map
360B dist/policy/index.js
369B dist/policy/index.js.map
152B dist/policy/preflight.d.ts
212B dist/policy/preflight.d.ts.map
7.6kB dist/policy/preflight.js
7.0kB dist/policy/preflight.js.map
125B dist/receipts/index.d.ts
187B dist/receipts/index.d.ts.map
123B dist/receipts/index.js
185B dist/receipts/index.js.map
727B dist/receipts/log.d.ts
549B dist/receipts/log.d.ts.map
3.3kB dist/receipts/log.js
3.6kB dist/receipts/log.js.map
2.5kB dist/safe/actions.d.ts
1.8kB dist/safe/actions.d.ts.map
16.7kB dist/safe/actions.js
13.9kB dist/safe/actions.js.map
877B dist/safe/index.d.ts
672B dist/safe/index.d.ts.map
2.9kB dist/safe/index.js
2.6kB dist/safe/index.js.map
3.4kB dist/sato-os/index.d.ts
2.4kB dist/sato-os/index.d.ts.map
9.6kB dist/sato-os/index.js
9.4kB dist/sato-os/index.js.map
1.1kB dist/signers/cdp.d.ts
1.1kB dist/signers/cdp.d.ts.map
1.6kB dist/signers/cdp.js
1.5kB dist/signers/cdp.js.map
1.0kB dist/signers/human-approve.d.ts
797B dist/signers/human-approve.d.ts.map
2.1kB dist/signers/human-approve.js
2.1kB dist/signers/human-approve.js.map
585B dist/signers/index.d.ts
550B dist/signers/index.d.ts.map
370B dist/signers/index.js
406B dist/signers/index.js.map
800B dist/signers/ows.d.ts
747B dist/signers/ows.d.ts.map
2.8kB dist/signers/ows.js
2.0kB dist/signers/ows.js.map
764B dist/signers/shared.d.ts
442B dist/signers/shared.d.ts.map
1.5kB dist/signers/shared.js
1.3kB dist/signers/shared.js.map
1.8kB dist/signers/solana-local.d.ts
852B dist/signers/solana-local.d.ts.map
3.3kB dist/signers/solana-local.js
2.9kB dist/signers/solana-local.js.map
954B dist/signers/viem-local.d.ts
611B dist/signers/viem-local.d.ts.map
4.2kB dist/signers/viem-local.js
2.9kB dist/signers/viem-local.js.map
3.2kB dist/solana/codec.d.ts
2.1kB dist/solana/codec.d.ts.map
10.3kB dist/solana/codec.js
12.0kB dist/solana/codec.js.map
1.4kB dist/solana/index.d.ts
858B dist/solana/index.d.ts.map
3.4kB dist/solana/index.js
3.2kB dist/solana/index.js.map
1.3kB dist/spec/canonical.d.ts
204B dist/spec/canonical.d.ts.map
2.3kB dist/spec/canonical.js
1.4kB dist/spec/canonical.js.map
239B dist/spec/index.d.ts
259B dist/spec/index.d.ts.map
556B dist/spec/index.js
309B dist/spec/index.js.map
10.2kB dist/spec/intent.d.ts
4.7kB dist/spec/intent.d.ts.map
6.3kB dist/spec/intent.js
4.2kB dist/spec/intent.js.map
2.2kB dist/spec/lint.d.ts
866B dist/spec/lint.d.ts.map
8.2kB dist/spec/lint.js
6.9kB dist/spec/lint.js.map
1.9kB dist/spec/names.d.ts
476B dist/spec/names.d.ts.map
2.9kB dist/spec/names.js
1.7kB dist/spec/names.js.map
7.0kB dist/spec/policy.d.ts
2.0kB dist/spec/policy.d.ts.map
11.1kB dist/spec/policy.js
7.8kB dist/spec/policy.js.map
5.1kB dist/spec/types.d.ts
1.8kB dist/spec/types.d.ts.map
3.1kB dist/spec/types.js
1.1kB dist/spec/types.js.map
2.1kB dist/spec/validate.d.ts
958B dist/spec/validate.d.ts.map
14.8kB dist/spec/validate.js
14.9kB dist/spec/validate.js.map
540B dist/surface/index.d.ts
507B dist/surface/index.d.ts.map
361B dist/surface/index.js
354B dist/surface/index.js.map
145B dist/surface/instructions.d.ts
194B dist/surface/instructions.d.ts.map
1.9kB dist/surface/instructions.js
354B dist/surface/instructions.js.map
1.2kB dist/surface/status.d.ts
1.1kB dist/surface/status.d.ts.map
2.7kB dist/surface/status.js
3.0kB dist/surface/status.js.map
754B dist/surface/statusFetch.d.ts
820B dist/surface/statusFetch.d.ts.map
1.9kB dist/surface/statusFetch.js
1.9kB dist/surface/statusFetch.js.map
2.7kB dist/surface/tools.d.ts
1.4kB dist/surface/tools.d.ts.map
12.8kB dist/surface/tools.js
8.5kB dist/surface/tools.js.map
7.4kB dist/types.d.ts
5.4kB dist/types.d.ts.map
44B dist/types.js
102B dist/types.js.map
307B dist/version.d.ts
202B dist/version.d.ts.map
300B dist/version.js
225B dist/version.js.map
354B gemini-extension.json
2.1kB llms-install.md
4.2kB package.json
765B server.json
3.4kB skill/SKILL.md
```

</details>

Post-publish checks:

```sh
npm view @satohub/kit@0.1.0 mcpName         # ai.satohub/kit
npm view @satohub/kit@0.1.0 dist-tags       # latest: 0.1.0
cd "$(mktemp -d)" && npx -y @satohub/kit@0.1 --help   # prints the sato-kit usage
```

Then list it on the official MCP Registry: the main app's
`docs/mcp-registry-runbook.md`, **Part 2** (domain login with
`MCP_REGISTRY_PRIVATE_HEX` from Vercel env, then from this repo's root
`mcp-publisher publish packages/kit/server.json`, then the `curl` check).
Never paste the key into a chat or commit.

### 2. `create-sato-agent`

1. **Bump the pinned templates commit.** `TEMPLATES_SHA` in
   `packages/create-sato-agent/src/index.ts` is what `--offline` copies. Set it to
   the current `main` of `satohubai/sato-agent-templates` whose nightly status is
   green:
   ```sh
   gh api repos/satohubai/sato-agent-templates/commits/main --jq .sha
   ```
   Edit the constant, `npm run build && npm test -w create-sato-agent`, commit.
2. **Remove the guard.** Delete `"private": true,` from
   `packages/create-sato-agent/package.json` (npm refuses to publish while it is
   there). Also drop "unpublished" from its README status line. Commit both with
   the sha bump.
3. **Publish:**
   ```sh
   npm pack --dry-run -w create-sato-agent   # 16 files, list below
   npm publish --access public -w create-sato-agent
   ```

Expected file list:

```
482B CHANGELOG.md
1.1kB LICENSE
3.8kB README.md
64B dist/cli.d.ts
100B dist/cli.d.ts.map
303B dist/cli.js
470B dist/cli.js.map
2.7kB dist/index.d.ts
1.9kB dist/index.d.ts.map
18.0kB dist/index.js
18.4kB dist/index.js.map
180B dist/tar.d.ts
260B dist/tar.d.ts.map
2.5kB dist/tar.js
3.3kB dist/tar.js.map
1.2kB package.json
```

Post-publish checks:

```sh
npm view create-sato-agent@0.1.0 bin           # { 'create-sato-agent': 'dist/cli.js' }
cd "$(mktemp -d)" && npx -y create-sato-agent@0.1 --help
cd "$(mktemp -d)" && npx -y create-sato-agent@0.1 "read my USDC balance on Base" --dir smoke --no-install --no-git   # needs satohub.ai/api/create live
```

### 3. Turn on the site

In the main app, set `NEXT_PUBLIC_SATO_KIT_PUBLISHED=1` in Vercel production
(`lib/kitLaunch.ts`; until then `/kit` redirects to `/instructions`) and
redeploy. Check `https://satohub.ai/kit` answers 200 and shows the install line.

### 4. Tag (optional, after both publishes)

`git tag kit-v0.1.0 && git tag create-sato-agent-v0.1.0 && git push --tags`
with the Sato Hub identity (`satohub88@gmail.com`).

## 0.2.1 — the user-agent patch (prepared 2026-09-26)

0.2.0 of `satohub-core`, `elizaos-plugin-satohub`, `agentkit-satohub` and
`goat-plugin-satohub` was published on 2026-09-26 from `2435df6`, the release
commit before the user-agent fix merged. Those tarballs still send
`satohub-integrations`, `SatoHub-elizaos-plugin`, `agentkit-satohub/0.1.0` and
`goat-plugin-satohub/0.1.0`. Sato Hub counts all four as packages, so nothing
is miscounted, but the versions in the header are wrong. 0.2.1 is that fix
alone. `satohub-ai-sdk-tools` 0.1.2 and `satohub-langchain-tools` 0.1.1 were
never published with the old strings, so they ship as they are.

| package | version | default user-agent |
| --- | --- | --- |
| satohub-core | 0.2.1 | `satohub-core-client/0.2.1` |
| elizaos-plugin-satohub | 0.2.1 | `elizaos-plugin-satohub/0.2.1` |
| agentkit-satohub | 0.2.1 | `agentkit-satohub/0.2.1` |
| goat-plugin-satohub | 0.2.1 | `goat-plugin-satohub/0.2.1` |
| satohub-ai-sdk-tools | 0.1.2 | `satohub-ai-sdk-tools/0.1.2` |
| satohub-langchain-tools | 0.1.1 | `satohub-langchain-tools/0.1.1` |

Each package's test pins its user-agent to its `package.json` version. An
explicit `userAgent` option still wins. Every framework package depends on
`satohub-core@^0.2.0`, which 0.2.1 satisfies; publish core first anyway:

```sh
npm run build && npm test
npm publish --access public -w satohub-core
npm publish --access public -w elizaos-plugin-satohub
npm publish --access public -w agentkit-satohub
npm publish --access public -w goat-plugin-satohub
npm publish --access public -w satohub-ai-sdk-tools
npm publish --access public -w satohub-langchain-tools
```

## 1. npm

All four names were free when this was written (2026-09-13; `registry.npmjs.org`
answered 404 for each). Publish in dependency order — the three framework
packages depend on `satohub-core@^0.1.0`, so it has to exist first.

```sh
npm login                       # owner account
npm run build

npm publish --access public -w satohub-core
npm publish --access public -w elizaos-plugin-satohub
npm publish --access public -w satohub-ai-sdk-tools
npm publish --access public -w satohub-langchain-tools
```

**GOAT SDK (added 2026-09-22, not yet published).** `goat-plugin-satohub` was
free on npm when written (`registry.npmjs.org` answered 404). It needs
`satohub-core` on npm first, which it already is:

```sh
npm run build
npm publish --access public -w goat-plugin-satohub
```

There is no upstream PR to follow it: `goat-sdk/goat` was marked archived on
2026-07-02 (README banner: "no issues, pull requests, or updates will be
accepted") and its last merged PR was #523 on 2025-08-19. Publishing to npm is
the whole of the distribution. `@goat-sdk/core` still sees roughly 1.6k
downloads a week (api.npmjs.org, week to 2026-09-21), which is the audience.

**Coinbase AgentKit (added 2026-09-23, not yet published).** `agentkit-satohub`
was free on npm when written (`registry.npmjs.org` answered 404). It depends on
`satohub-core@^0.1.0` (already published) and peers on `@coinbase/agentkit`
`^0.10.0` — 0.10.4 is both npm `latest` and the version most installs use.

```sh
npm run build
npm publish --access public -w agentkit-satohub
```

There is no upstream PR to follow it yet. `coinbase/agentkit` accepts
third-party action providers by PR in principle, but none has been merged since
2026-03-17 (dTelecom, #982), and npm `latest` (0.10.4) dates from 2025-12-19. A
PR in their layout is prepared separately; it does not conflict with this
package.

`npm pack --dry-run -w <pkg>` first if you want to see exactly what ships:
`dist/`, `README.md`, `LICENSE`, nothing else.

Unscoped names are deliberate. `@elizaos/*` is reserved for first-party packages
and is rejected by the elizaOS registry validator; an unscoped
`elizaos-plugin-*` is the documented community form, and it needs no npm org.

## 2. The elizaOS community registry

The registry moved **into the monorepo**: the old `elizaos-plugins/registry`
repo is archived and read-only, and third-party packages are now listed by
adding one JSON file to `elizaOS/eliza` under
`packages/registry/entries/third-party/` and opening a PR. The default branch
is `develop`.
Source: `packages/registry/README.md` in that repo.

Listing is **discoverability and curation, not a requirement to run the
plugin** — the runtime auto-discovers any npm package whose `keywords` include
`elizaos`, which ours does. But it must be on npm before the entry means
anything, so step 1 comes first.

The entry file is already written and validated against their schema by hand:
[`registry/elizaos/elizaos-plugin-satohub.json`](registry/elizaos/elizaos-plugin-satohub.json).
`package`, `repository` and `kind` are the required fields; ours also carries
`description`, `homepage`, `version`, `directory` and `tags`, matching the shape
of the entries already merged there.

After `npm publish`:

```sh
gh repo fork elizaOS/eliza --clone --remote
cd eliza && git checkout -b registry/satohub develop

cp <this repo>/registry/elizaos/elizaos-plugin-satohub.json \
   packages/registry/entries/third-party/elizaos-plugin-satohub.json

bun run --cwd packages/registry validate
bun run --cwd packages/registry generate     # regenerates generated-registry.json

git add packages/registry
git commit -m "registry: add elizaos-plugin-satohub"
gh pr create --base develop --title "registry: add elizaos-plugin-satohub (Sato Hub onchain-agent index, Preflight, Sato Route)"
```

The PR must include **both** the entry file and the regenerated
`generated-registry.json`. Community entries are reviewed for security,
functionality and documentation quality before merge; reviewers on recent PRs
have asked for evidence of the plugin working against elizaOS, so attach a
transcript of an agent calling `SATOHUB_SEARCH_RESOURCES` and
`SATOHUB_PREFLIGHT`.

If you would rather confirm the derived metadata than trust the hand-written
file, `elizaos plugins submit . --dry-run` inside
`packages/elizaos-plugin-satohub` prints what their CLI would generate from our
`package.json`.

## 3. ClawHub (OpenClaw skills) — a different artefact

ClawHub lists **skills**, not npm packages, and the Sato Hub skill already
exists as `satohubai/sato-hub-skill` in the format ClawHub wants: a folder
containing `SKILL.md` with YAML frontmatter whose `name` matches the parent
directory (`skills/sato-hub/`).

Publishing needs the separate `clawhub` CLI and a GitHub account old enough to
pass their upload gate — an interactive login this repo's agent does not hold:

```sh
clawhub publish skills/sato-hub --dry-run   # prints the exact publish plan
clawhub publish skills/sato-hub
```

Note before you run it: **everything published on ClawHub is licensed MIT-0.**
Our skill is MIT already, so this is a relicensing decision rather than a
blocker, but it is a decision.

## What deliberately has no registry PR

The Vercel AI SDK and LangChain.js have no community tool registry that accepts
a GitHub-sourced pull request — both discover tools through npm and their own
documentation. Publishing the packages is the whole of the distribution there.
