// Vendored verbatim into @satohub/kit (packages/kit/src/spec). Edit here, then re-vendor.
/**
 * ODA id ↔ tool name. Deterministic, and the only place the mapping lives.
 *
 * WHY: an ODA id is dotted (`swap.prepare`) because it names a family and a
 * step. Hosts do not accept that as a tool name — OpenAI rejects dots, Cursor
 * and Claude Code expect short snake_case — so every host sees the SAME
 * derived name: dots become underscores, nothing else changes. A second
 * mapping anywhere else would let two surfaces disagree about what a tool is
 * called, which is exactly the drift AI SDK 7 now flags.
 *
 * Id grammar: two or more segments joined by "."; each segment is lowercase,
 * starts with a letter, and may contain digits and single underscores
 * (`erc8004.lookup`, `hyperliquid.order_prepare`). The derived name must be at
 * most TOOL_NAME_MAX characters.
 *
 * THE INVERSE is only defined where it is unambiguous. `swap_prepare` has one
 * underscore, and ids need at least one dot, so it can only be `swap.prepare`.
 * `hyperliquid_order_prepare` could be `hyperliquid.order_prepare` or
 * `hyperliquid.order.prepare` — ambiguous, so the inverse returns null unless
 * the caller hands in the ids it knows and exactly one of them matches.
 */

export const TOOL_NAME_MAX = 40;

const SEGMENT = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";
export const ODA_ID_RE = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})+$`);
export const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function isOdaId(id: unknown): id is string {
  return typeof id === "string" && ODA_ID_RE.test(id);
}

/** `swap.prepare` → `swap_prepare`. Throws on an invalid id or a name over TOOL_NAME_MAX. */
export function odaIdToToolName(id: string): string {
  if (!isOdaId(id)) {
    throw new Error(`odaIdToToolName: ${JSON.stringify(id)} is not an ODA id (dotted lowercase segments, e.g. "swap.prepare")`);
  }
  const name = id.split(".").join("_");
  if (name.length > TOOL_NAME_MAX) {
    throw new Error(`odaIdToToolName: ${JSON.stringify(name)} is ${name.length} characters; the limit is ${TOOL_NAME_MAX}`);
  }
  return name;
}

/**
 * `swap_prepare` → `swap.prepare` where unambiguous. With `knownIds`, returns
 * the one known id that maps to this name (null if none or more than one).
 * Without it, returns an id only when the name has exactly one underscore.
 */
export function toolNameToOdaId(name: string, knownIds?: readonly string[]): string | null {
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name) || name.length > TOOL_NAME_MAX) return null;
  if (knownIds) {
    const hits = knownIds.filter((id) => isOdaId(id) && id.split(".").join("_") === name);
    return hits.length === 1 ? (hits[0] ?? null) : null;
  }
  const parts = name.split("_");
  if (parts.length !== 2) return null;
  const id = parts.join(".");
  return isOdaId(id) ? id : null;
}
