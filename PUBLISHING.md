# Publishing

Two things are gated on an account this repo's build agent does not hold: an
npm login, and nothing else. Everything short of those is done and checked in.

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
