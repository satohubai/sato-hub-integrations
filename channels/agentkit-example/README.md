# AgentKit example PR (draft, not submitted)

`typescript/examples/langchain-sato-kit-chatbot/` is laid out exactly where it would land in
`coinbase/agentkit` (copy the `typescript/` folder over the repo root). It follows the existing
`typescript/examples/langchain-cdp-chatbot` (same `tsconfig.json`, `.eslintrc.json`, `.prettierrc`,
`.prettierignore`, `.env-local` layout, `workspace:*` AgentKit dependencies). `PR.md` is the PR body,
written against the repo's pull request template (Description / Tests / Checklist).

- `sato.ts` — `walletProviderSigner()` (a Sato Kit signer over any AgentKit `EvmWalletProvider`) and
  `createAgentKitWithSato()`; typechecked in this repo against the local kit and AgentKit.
- `chatbot.ts` — the LangChain glue, same shape as the CDP chatbot, with chat mode only.

Apply:

```bash
git clone https://github.com/<fork of coinbase/agentkit>.git agentkit && cd agentkit
cp -R <this repo>/channels/agentkit-example/typescript .
pnpm install && pnpm build
cd typescript/examples/langchain-sato-kit-chatbot && pnpm lint && pnpm start
```

The repo requires signed commits (stated in its PR template).
