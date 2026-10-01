# Privacy Policy — Sato Hub plugin for Dify

Last updated: 2026-09-28

## Summary

The plugin collects no personal data, asks for no credentials, and stores and logs nothing itself. It sends each tool's inputs to one service, Sato Hub (https://satohub.ai), over HTTPS, and returns Sato Hub's answer to your Dify app.

## What the plugin sends, per tool

| Tool | Sent to satohub.ai | Not sent |
| --- | --- | --- |
| `recommend_stack` | the goal text, and the optional chain and constraints you give | anything else |
| `search_listings` | your search keywords and the optional chain, category and result-count filters | anything else |
| `preflight` | the target type and the target (a repo, a package name, or an MCP endpoint URL) | anything else |

Every request also carries the plugin's fixed user-agent, `dify-plugin-satohub/<version>`, and comes from the network address of the machine running your Dify plugin runtime (on Dify Cloud, Dify's servers, not the end user's device).

When `preflight` is given an MCP endpoint URL, Sato Hub's server contacts that URL once (an MCP handshake) to report whether it answered.

## What Sato Hub records about these requests

Sato Hub keeps usage records so it can see which parts of its API are used and which questions return nothing. For each request it records:

- the endpoint called, the time, the HTTP status, the response size and how long it took;
- the user-agent string (for this plugin, its name and version);
- a keyed one-way hash of the requesting network address (never the address itself) and the country the hosting provider derives from it;
- for `preflight`, the target and the verdict; for `search_listings`, a short sanitised copy of the search arguments; for `recommend_stack`, the goal text is **not** recorded, only the kind of build Sato Hub read from it (for example, "data").

These records contain nothing that identifies a person and are kept in aggregate without a fixed deletion date. Sato Hub does not sell data, show ads, set tracking cookies or train models on this data.

Sato Hub runs on Vercel (hosting) and Supabase (database), which process these requests on its behalf under their own policies.

Please do not put personal data (names, email addresses, private keys, seed phrases) into tool inputs. They are not needed for any tool.

## Credentials

None. The plugin has no API key or credential field, and Sato Hub's public API requires no authentication.

## Your requests

Sato Hub's full privacy policy is at https://satohub.ai/privacy. To ask what is held, or to have something corrected or deleted, contact satohub88@gmail.com or use https://satohub.ai/os/support.
