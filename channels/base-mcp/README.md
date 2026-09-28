# Base MCP plugin spec (draft, not submitted)

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
