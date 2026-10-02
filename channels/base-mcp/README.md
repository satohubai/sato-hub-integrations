# Base MCP plugin spec (custom plugin; not submitted to Base)

## Status (2026-10-02)

- **Not submitted, on purpose.** `base/skills` `CONTRIBUTING.md` limits contributions to the Base core
  team. In practice the third-party plugins that were merged (KyberSwap, Bitrefill, GMGN, Clawnch,
  o1.exchange) came in around June from those protocols' own teams. Since late June, 17 outside
  plugin PRs and the outside plugin proposals filed as issues have had no merge and no reply.
- **Shipped as a custom plugin instead.** Base MCP lets a user add a plugin next to the native ones.
  The steps are in the kit README, section "Use with Base MCP". `npx skills add base/skills --skill
  base-mcp` installs the skill at `.claude/skills/base-mcp/`, so `sato-kit.md` copied into its
  `plugins/` folder keeps its relative links to Base's `references/` working.
- **Rename.** Base MCP's server URL is now `https://wallet-mcp.coinbase.com` (base/skills #166,
  2026-10-01). `https://mcp.base.org` still works for existing connections. The skill id stays
  `base-mcp`. This plugin names no URL, so it needed no change.
- **Spec checked again 2026-10-02.** `plugin-spec.md` has not changed since 2026-06-23 (#122), and
  this file still follows its frontmatter and canonical section order.
- **If Base opens to outside plugins:** the original path below still applies (ask first, then a
  PR from `satohubai` with signed commits and their `/plugin-review` report).


`sato-kit.md` is a Base MCP plugin written to the Base MCP plugin specification in
[`base/skills`](https://github.com/base/skills), file
`skills/base-mcp/references/plugin-spec.md` (read at commit
`15adb8d9c75e5c7d1461e183a9021170a6ddbc08`). A plugin is one Markdown file at
`skills/base-mcp/plugins/<slug>.md`: YAML frontmatter, then the canonical body sections in a
fixed order. There is no build step or validator upstream; conformance is by review, helped by
the `plugin-review` skill in that repo (`.claude/skills/plugin-review/`).

## What we checked the draft against

- Frontmatter: `title`, `description`, `tags`, `name`, `version`, `integration`, `chains`, plus
  `requires.{shell,allowlist,externalMcp,cliPackage}`, `auth`, `risk`.
- `integration: cli-only` → `## Commands`, `shell: required`, `cliPackage` set, and a stop on
  shell-less surfaces.
- A `cliPackage` runs third-party code on the user's machine → `local-exec` risk tag, with the
  version pinned (never `@latest`).
- Sections in canonical order: IMPORTANT callout, Overview, Installation, Surface Routing,
  Commands, Orchestration, Submission, Example Prompts, Risks & Warnings, Notes.
- Submission names `send_calls` and shows the `{ to, value, data }` mapping, with `value`
  converted to hex.
- Neutral language: no yield or performance claims, no default tokens.

`channels/test/channels.test.mjs` asserts the frontmatter fields, the section order and the
pinned version, so the draft cannot drift from the spec's shape without a red test.

`tags` introduces one new tag, `policy`. The spec allows a new tag; a contribution appends it to
the vocabulary list in `plugin-spec.md` in the same PR.

## Why the kit maps onto Base MCP this way

Base MCP never signs on the agent's behalf: every write goes to the user's Base Account for
approval. That is the kit's `human-approve` mode. So the plugin uses the kit for what it adds
(the policy pre-flight, the simulation, the fee disclosure, one intent per transaction) and hands
the unsigned transaction to `send_calls`. The kit's `execute` is not used on this path.

x402 payments (`x402.prepare`) are left out of this draft: they need an EIP-3009 typed-data
signature, and how Base MCP `sign` handles typed data is not covered by the spec we read. Add
them only after confirming that with the Base MCP tool descriptions.
