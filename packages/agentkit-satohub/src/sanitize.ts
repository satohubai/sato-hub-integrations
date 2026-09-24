/**
 * Some of what Sato Hub returns is third-party text: listing names and
 * descriptions, token names and symbols read from a contract, the error a
 * probed endpoint gave. AgentKit's "Managing Risk" guidance names exactly this
 * — an action provider that pulls outside text into the model's context — as an
 * indirect prompt-injection surface.
 *
 * So every string copied into tool output passes through here. It removes what
 * a reader cannot see (control, format, private-use and surrogate code points:
 * zero-width characters, bidi overrides), collapses whitespace and bounds the
 * length. It does not rewrite, summarise or judge the text. This mirrors
 * AgentKit's own `sanitizeOnchainMetadata`, which no published AgentKit release
 * exports yet.
 */

import { MAX_TEXT_LENGTH } from "./constants.js";

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu;

export function clean(value: string, maxLength = MAX_TEXT_LENGTH): string {
  return value
    .replace(/[\t\n\r\v\f]+/g, " ")
    .replace(INVISIBLE, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function cleanOrNull(value: unknown, maxLength = MAX_TEXT_LENGTH): string | null {
  return typeof value === "string" ? clean(value, maxLength) : null;
}

/** Keeps a URL only if it parses as http(s), and drops utm_* parameters. */
export function urlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_")) url.searchParams.delete(key);
    }
    return clean(url.toString(), 300);
  } catch {
    return null;
  }
}

/** A list of short strings, at most ten. */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .slice(0, 10)
    .map((v) => clean(v, 40));
}
