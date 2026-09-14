/**
 * The consumer side of Sato Hub response signing — vendored verbatim in spirit
 * from the app's own `lib/verifySignature.ts`, so the thing we describe and the
 * thing we run are the same forty lines.
 *
 * PURE. Nothing here fetches or reads an environment. You hand it a body, the
 * headers, and a JWKS you fetched yourself.
 *
 * WHAT A PASS MEANS. These bytes left Sato Hub unaltered, under key `kid`, at
 * the stamped time. Nothing more. A signed verdict is still a verdict and a
 * signed route is still a recommendation. A valid signature is not a safety
 * claim.
 */

import crypto from "node:crypto";
import { canonicalJson, bodyForSigning, parseSignatureHeader, signingMessage, SIGNING_ALG } from "./signing.js";

export type Jwk = { kty: string; crv?: string; x?: string; kid?: string; use?: string; alg?: string };
export type Jwks = { keys: Jwk[] };

export type VerifyResult =
  | { ok: true; kid: string; signed_at: string }
  | { ok: false; reason: string };

function fail(reason: string): VerifyResult {
  return { ok: false, reason };
}

/** Import an Ed25519 JWK as a public key. Returns null for anything else. */
export function publicKeyFromJwk(jwk: Jwk): crypto.KeyObject | null {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) return null;
  try {
    return crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
  } catch {
    return null;
  }
}

function verifyRaw(message: Buffer, sigB64Url: string, key: crypto.KeyObject): boolean {
  try {
    const sig = Buffer.from(sigB64Url.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (sig.length !== 64) return false; // Ed25519 signatures are 64 bytes, always
    return crypto.verify(null, message, key, sig);
  } catch {
    return false;
  }
}

function headerOf(headers: Headers | Record<string, string | undefined>, name: string): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const rec = headers as Record<string, string | undefined>;
  const hit = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? rec[hit] ?? null : null;
}

function keyFor(jwks: Jwks, kid: string): crypto.KeyObject | null {
  const jwk = jwks.keys?.find((k) => k.kid === kid);
  return jwk ? publicKeyFromJwk(jwk) : null;
}

/**
 * Verify `Sato-Signature` against the RAW response body.
 *
 * `body` must be the bytes as received — not a re-serialised object. One added
 * space and this fails, which is the point.
 */
export function verifyResponseSignature(
  body: string | Uint8Array,
  headers: Headers | Record<string, string | undefined>,
  jwks: Jwks,
): VerifyResult {
  const parsed = parseSignatureHeader(headerOf(headers, "Sato-Signature"));
  if (!parsed) return fail("No Sato-Signature header. This response is unsigned — unknown, not invalid.");
  if (parsed.alg !== SIGNING_ALG) return fail(`Unexpected alg ${parsed.alg}; only ${SIGNING_ALG} is issued.`);
  const signedAt = headerOf(headers, "Sato-Signed-At");
  if (!signedAt) return fail("Sato-Signature present without Sato-Signed-At; the timestamp is inside the signed message.");
  const key = keyFor(jwks, parsed.kid);
  if (!key) return fail(`kid ${parsed.kid} is not in the JWKS you supplied. Re-fetch it; retired kids stay published for 90 days.`);
  const ok = verifyRaw(signingMessage(signedAt, body), parsed.sig, key);
  return ok ? { ok: true, kid: parsed.kid, signed_at: signedAt } : fail("Signature does not match these bytes.");
}

/**
 * Verify the embedded `meta.signature` against the parsed body — for consumers
 * that never see headers (an MCP `structuredContent` block, a stored receipt, a
 * payload pasted into a ticket).
 */
export function verifyBodySignature(body: unknown, jwks: Jwks): VerifyResult {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const meta = b?.meta as Record<string, unknown> | undefined;
  const sig = meta?.signature as { kid?: string; sig?: string; alg?: string; signed_at?: string } | null | undefined;
  if (sig === null) return fail("meta.signature is null: this response was produced with no signing key configured.");
  if (!sig?.kid || !sig.sig || !sig.signed_at) return fail("No meta.signature block.");
  if (sig.alg !== SIGNING_ALG) return fail(`Unexpected alg ${sig.alg}; only ${SIGNING_ALG} is issued.`);
  const key = keyFor(jwks, sig.kid);
  if (!key) return fail(`kid ${sig.kid} is not in the JWKS you supplied.`);
  const message = signingMessage(sig.signed_at, canonicalJson(bodyForSigning(b)));
  return verifyRaw(message, sig.sig, key)
    ? { ok: true, kid: sig.kid, signed_at: sig.signed_at }
    : fail("Signature does not match the canonical body.");
}
