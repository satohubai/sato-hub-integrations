/**
 * Turning a message into arguments, deterministically.
 *
 * An elizaOS action receives a `Memory`, not a typed argument object. There are
 * two ways to get arguments out of it: ask a model, or read the text with
 * rules. This file does the second, and only for things that have an
 * unambiguous written form — a `owner/repo`, a URL, a `chain:id` pair, an
 * 0x-address. Everything else is passed through as free text for Sato Hub's own
 * search to handle, or required in `options`.
 *
 * NOTHING HERE GUESSES A NUMBER. A swap needs a chain, two tokens and an
 * amount; an amount inferred from prose is how someone trades 1000 of something
 * they meant to trade 10 of. `SATOHUB_ROUTE_SWAP_QUOTE` therefore requires
 * `options` and says so when they are absent, rather than reading a figure out
 * of a sentence.
 */

import type { PreflightInput } from "satohub-core";

export function messageText(message: { content?: { text?: string } } | undefined): string {
  return (message?.content?.text ?? "").trim();
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/i;
const REPO_RE = /\bgithub\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/i;
const BARE_REPO_RE = /(?:^|\s)([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)(?=$|\s|[.,])/;
const AGENT_RE = /\b([a-z]+):(\d+)\b/;
const EVM_ADDRESS_RE = /\b(0x[a-fA-F0-9]{40})\b/;
const CHAIN_RE = /\b(base|ethereum|arbitrum|optimism|polygon|solana|bnb chain|avalanche)\b/i;

/**
 * Read a single Preflight target out of a sentence, in the order the written
 * forms are unambiguous. Returns null when nothing unambiguous is present —
 * which is the right answer, not a failure.
 */
export function parsePreflightTarget(text: string): PreflightInput | null {
  const repoUrl = text.match(REPO_RE);
  if (repoUrl?.[1]) return { repo: repoUrl[1].replace(/\.git$/, "") };

  const url = text.match(URL_RE);
  if (url?.[0]) return { endpoint: url[0] };

  const address = text.match(EVM_ADDRESS_RE);
  if (address?.[1]) {
    const chain = text.match(CHAIN_RE);
    // A token needs a chain; without one there is no lane to run, so say so by
    // returning nothing rather than defaulting to a chain the user never named.
    return chain?.[1] ? { token: address[1], chain: chain[1] } : null;
  }

  const agent = text.match(AGENT_RE);
  if (agent?.[1] && agent[2]) return { agent: `${agent[1]}:${agent[2]}` };

  const bare = text.match(BARE_REPO_RE);
  if (bare?.[1]) return { repo: bare[1] };

  return null;
}

/** The chain, when the message names one of the ones we route on. */
export function parseChain(text: string): string | undefined {
  const hit = text.match(CHAIN_RE);
  return hit?.[1];
}

/**
 * Strip the conversational shell off a search request so the query is terms
 * rather than a sentence. Cheap, reversible, and never drops a term it does not
 * recognise.
 */
export function searchQueryFrom(text: string): string {
  return text
    .replace(
      /^\s*(?:(?:hey|hi|ok|okay|please|can you|could you|i want to|i need to|find me|find|search for|search|look up|show me|what)\b[\s,]*)+/i,
      "",
    )
    .replace(/\b(on sato ?hub|in the directory|please)\b/gi, "")
    .replace(/[?!]+$/, "")
    .trim();
}

const INSTALL_RE =
  /(?:\b(?:npm|pnpm|bun)\s+(?:add|install|i)\s+\S+|\byarn\s+add\s+\S+|\bnpx\s+(?:-y|--yes)\s+\S+|\bpip3?\s+install\s+\S+|\buvx\s+\S+|\bpipx\s+run\s+\S+|\bclaude\s+mcp\s+add\s+[^\n`]+)/;

/** The install command inside a message (`npm i x`, `uvx y`, `claude mcp add …`), or null. */
export function installCommandFrom(text: string): string | null {
  return text.match(INSTALL_RE)?.[0]?.trim() ?? null;
}
