# create-sato-agent

Create a runnable onchain agent repo from a plain-words goal. The goal picks a
template that is checked nightly in
[satohubai/sato-agent-templates](https://github.com/satohubai/sato-agent-templates);
the CLI writes it into a new directory, runs `npm ci` and makes a first git commit.

> **Status: 0.1.0.** The templates and each one's latest nightly result are listed at
> [satohub.ai/templates](https://satohub.ai/templates) and [satohub.ai/status](https://satohub.ai/status).

```sh
npx create-sato-agent@0.1 "swap USDC to ETH on Base under a daily cap" --framework plain-ts
# or
npm create sato-agent -- "swap USDC to ETH on Base under a daily cap"
```

The goal is sent to `POST https://satohub.ai/api/create` to choose a template.
Sato Hub does not store it. Requests carry the user agent `create-sato-agent/0.1.0`.

## Options

| Flag | Meaning |
|---|---|
| `--framework <fw>` | `plain-ts` · `agentkit` · `eliza` · `ai-sdk` · `claude-agent-sdk` · `openai-agents` (no template → refusal with the nearest ones) |
| `--chain <chain>` | `base` · `base-sepolia` |
| `--network <net>` | `fork` (default) · `testnet` · `mainnet` |
| `--template <id>` | pick a template by id |
| `--dir <path>` | target directory (default: slug of the template id). A non-empty directory is refused. |
| `--yes` | accept defaults. **Never enables mainnet.** |
| `--no-install` | skip `npm ci` |
| `--no-git` | skip `git init` + first commit |
| `--dry-run` | print the plan and file list, write nothing |
| `--json` | machine-readable output |
| `--offline` | skip the API: download the templates repo at a pinned commit and copy `templates/<id>/<fw>/` as-is — no server plan, no signed manifest, `last_green` is `null` |
| `--i-accept-mainnet-risk` | required with `--network mainnet` unless you confirm at an interactive prompt |
| `--api <url>` | create endpoint (default `https://satohub.ai/api/create`) |

## Agent and CI mode — it never prompts

The CLI prompts only for a person at a TTY who passed **no flags at all**. It never
reads stdin when any of these hold:

- stdin or stdout is not a TTY
- `CI` is set
- a coding-agent variable is set (non-empty): `CLAUDECODE`, `CLAUDE_CODE`,
  `CLAUDE_CODE_ENTRYPOINT`, `CURSOR_AGENT`, `CURSOR_TRACE_ID`, `CODEX_SANDBOX`,
  any `CODEX_*`, `GEMINI_CLI`, `AGENT`, `OPENCODE`, `AIDER`, `CLINE_ACTIVE`,
  `GOOSE_TERMINAL`, `AMP_AGENT`, `WINDSURF_AGENT`
- any flag was passed

In interactive mode it asks for the goal (if missing) and the network; choosing
mainnet asks a y/N confirm, default No.

## Mainnet

Mainnet needs `--network mainnet` **and** either the interactive confirm or
`--i-accept-mainnet-risk`. `--yes` alone is refused with rule `cli.mainnet_confirm`.
`--offline` never creates a mainnet agent.

## Output and exit codes

`--json` prints one line:

```json
{"ok":true,"dir":"/abs/path","template":{"id":"…","version":"…","digest":"…","framework":"plain-ts"},"files_written":["…"],"env_names":["…"],"next_commands":["cd …","…"],"last_green":"2026-09-25"}
{"ok":false,"error":"no_template","message":"…","rule":"…"}
```

`files_written` is the list of relative paths written. With `--dry-run` it is
empty and `files` lists what would be written (plus `"dry_run":true`).
A server refusal also carries `nearest` / `blocked` when the server sent them.

| Exit | Meaning |
|---|---|
| 0 | created (or dry run) |
| 2 | refused — the message names the rule id |
| 1 | error (network, bad response, write failure) |

`last_green` is the date the template last passed its nightly checks
(https://satohub.ai/status). A date there means it passed those checks that night;
it is not a statement that the code is safe to run with real funds.

## Development

```sh
npm test -w create-sato-agent   # offline: fake HTTP server on 127.0.0.1 + fixture tarball
```

Zero runtime dependencies. Node ≥ 20.
