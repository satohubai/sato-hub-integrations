# Skill listings for `sato-kit` (draft, not submitted)

One skill text, two registries. The source of truth is `packages/kit/skill/SKILL.md`
(agentskills.io format). Nothing here edits it.

| Registry | What it reads | File |
|---|---|---|
| skills.sh (the `skills` CLI) | the kit's `SKILL.md` as-is, straight from this GitHub repo | `packages/kit/skill/SKILL.md` |
| ClawHub | a copy with ClawHub's two frontmatter differences | `clawhub/sato-kit/SKILL.md` (generated) |

## ClawHub

ClawHub refuses a `SKILL.md` that has a `license:` line ("do not add conflicting license terms";
the hosted copy is published under ClawHub's own terms) and needs a top-level `version:`. Its
importer reports both as a generic server error. `build-clawhub-skill.mjs` makes exactly those
two changes and copies the body byte for byte; the channels test fails when the copy is stale.

```bash
node channels/skills/build-clawhub-skill.mjs          # regenerate
node channels/skills/build-clawhub-skill.mjs --check  # CI: fail when stale
```

Exact publish fields:

| Field | Value |
|---|---|
| slug | `sato-kit` |
| owner | `satohubai` |
| display name | `Sato Kit` |
| version | `0.1.0` (must equal `metadata.version` in the kit's `SKILL.md`) |
| source repo | `satohubai/sato-hub-integrations` |
| source ref | `main` |
| source commit | the merge commit of the PR that last changed `clawhub/sato-kit/SKILL.md` |
| source path | `channels/skills/clawhub/sato-kit` |
| requires.bins | `node`, `npx` (from `metadata.openclaw.requires`) |
| requires.env | none |
| license on the hosted copy | whatever ClawHub applies at publish time; the repo stays MIT |
| changelog | `First listing: the Sato Kit CLI (read, prepare, execute, doctor) with a policy pre-flight.` |

Command (owner, signed in as `satohubai`; dry-run first):

```bash
npx -y clawhub@<pinned version> login
npx -y clawhub@<pinned version> publish channels/skills/clawhub/sato-kit \
  --slug sato-kit --owner satohubai --version 0.1.0 \
  --source-repo satohubai/sato-hub-integrations --source-ref main \
  --source-commit <sha> --source-path channels/skills/clawhub/sato-kit --dry-run
```

ClawHub runs its own scans before a listing turns public; the result is ClawHub's, attributed to
ClawHub wherever we mention it.

## skills.sh

skills.sh has no submission form. A skill appears there once people install it with the `skills`
CLI, which reads `SKILL.md` files straight from a GitHub repo. The `license:` line is fine here.

Check discovery before telling anyone the command:

```bash
npx -y skills@<pinned version> add satohubai/sato-hub-integrations --list
npx -y skills@<pinned version> add satohubai/sato-hub-integrations --skill sato-kit
```

The fields skills.sh shows come from the kit's frontmatter: `name` (`sato-kit`), `description`,
`compatibility`, `metadata.homepage`. Keep the description free of dates, counts, prices and
sponsorship.

## What must be true first

1. `@satohub/kit@0.1.0` is published on npm. Every command in the skill runs
   `npx -y @satohub/kit@0.1 …`; before publish those commands fail.
2. `satohubai/sato-hub-integrations` is public (both registries read GitHub).
3. `metadata.version` in the kit's `SKILL.md` equals the published kit version.
