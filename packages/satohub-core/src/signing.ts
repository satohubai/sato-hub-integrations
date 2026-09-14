/**
 * The signing primitives, vendored from the Sato Hub app's `lib/signing.ts`.
 *
 * Vendored rather than depended on, because a verifier that pulls a package
 * from the party it is verifying is not a verifier. These are forty lines of
 * pure string handling; copy them, read them, keep them.
 *
 * Scheme: Ed25519 (RFC 8032) as JWS `alg: "EdDSA"` (RFC 8037 3.1), detached
 * payload (RFC 7797 / RFC 7515 Appendix F).
 * Reference: https://satohub.ai/.well-known/sato-signing.json
 */

/** The only algorithm Sato Hub emits. */
export const SIGNING_ALG = "EdDSA" as const;

export const SIGNATURE_HEADER = "Sato-Signature";
export const SIGNED_AT_HEADER = "Sato-Signed-At";

/**
 * Canonical JSON, defined exactly: object keys sorted by Unicode code point,
 * array order preserved (order IS data), no whitespace, `undefined` omitted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined && typeof obj[k] !== "function")
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** The body with `meta.signature` removed — a signature cannot cover itself. */
export function bodyForSigning(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const meta = b.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return b;
  const rest: Record<string, unknown> = { ...(meta as Record<string, unknown>) };
  delete rest.signature;
  return { ...b, meta: rest };
}

/** `kid=…, alg=…, sig=…` → its parts. Returns null if any part is missing. */
export function parseSignatureHeader(
  value: string | null | undefined,
): { kid: string; alg: string; sig: string } | null {
  if (!value) return null;
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  if (!out.kid || !out.sig || !out.alg) return null;
  return { kid: out.kid, alg: out.alg, sig: out.sig };
}

/**
 * message = utf8(signed_at) || 0x0A || payload.
 *
 * The timestamp is INSIDE the signed message, so a body cannot be replayed
 * under a different date.
 */
export function signingMessage(signedAt: string, payload: Uint8Array | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  return Buffer.concat([Buffer.from(signedAt, "utf8"), Buffer.from([0x0a]), body]);
}
