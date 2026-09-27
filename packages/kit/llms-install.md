# Installing Sato Kit (@satohub/kit)

Sato Kit runs locally as a stdio MCP server. Every install below pins **0.1**, so an upgrade is always a deliberate change.

```bash
npx -y @satohub/kit@0.1 mcp
```

Requirements: Node.js 20+ and npx. No API key. The network is **fork** by default; mainnet needs an
explicit opt-in in `policy.json`. The kit's policy is a pre-flight that explains refusals; your
signer is what enforces limits.

## Claude Code

```bash
claude mcp add sato-kit -- npx -y @satohub/kit@0.1 mcp
```

Or install the plugin in this folder (`.claude-plugin/plugin.json` + `.mcp.json` + `skill/`).

## Cursor

One-click: [Add Sato Kit to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=sato-kit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBzYXRvaHViL2tpdEAwLjEiLCJtY3AiXX0=)

The `config` parameter is base64 of `{"command":"npx","args":["-y","@satohub/kit@0.1","mcp"]}`.
Or add to `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "sato-kit": { "command": "npx", "args": ["-y", "@satohub/kit@0.1", "mcp"] } } }
```

## Codex

```bash
codex mcp add sato-kit -- npx -y @satohub/kit@0.1 mcp
```

Or use the plugin manifest in `.codex-plugin/plugin.json` (skills from `skill/`, server from `.mcp.json`).

## Gemini CLI

`gemini-extension.json` in this folder declares the same server.

## Any MCP client

```json
{ "command": "npx", "args": ["-y", "@satohub/kit@0.1", "mcp"] }
```

For the full tool set add `--toolsets all` to `args`.

## Formats followed (checked 2026-09-26)

- MCP Registry server.json: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md
- Claude Code plugin manifest: https://code.claude.com/docs/en/plugins-reference
- Codex plugins: https://developers.openai.com/codex/plugins/build
- Gemini CLI extensions: https://geminicli.com/docs/extensions/reference/
- Cursor install links: https://cursor.com/docs/context/mcp/install-links
- Context7 context7.json: https://context7.com/docs/adding-libraries
- Agent Skills (SKILL.md): https://agentskills.io/specification
