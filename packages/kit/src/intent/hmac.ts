// INTENT builder. intent_id / params_digest per the frozen contract in spec/intent.ts.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson, formatIntentId, intentIdMacInput, isIntentId, base64url } from "../spec/index.js";
import type { IntentIdFields } from "../spec/index.js";

/** hex(sha256(utf8 s)). */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** "sha256:" + hex(sha256(canonicalJson(params))). */
export function paramsDigest(params: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(params))}`;
}

/** "si_" + base64url(HMAC-SHA256(secret, intentIdMacInput(fields))). */
export function computeIntentId(secret: Uint8Array, fields: IntentIdFields): string {
  if (!(secret instanceof Uint8Array) || secret.length < 16) throw new Error("intent secret must be at least 16 bytes");
  const mac = createHmac("sha256", secret).update(intentIdMacInput(fields), "utf8").digest();
  return formatIntentId(new Uint8Array(mac));
}

/** Constant-time check that `id` is the MAC of `fields` under `secret`. */
export function verifyIntentId(secret: Uint8Array, id: string, fields: IntentIdFields): boolean {
  if (!isIntentId(id)) return false;
  const expected = Buffer.from(computeIntentId(secret, fields), "utf8");
  const got = Buffer.from(id, "utf8");
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** base64url of 16 random bytes. */
export function newNonce(): string {
  return base64url(new Uint8Array(randomBytes(16)));
}

/** 32 random bytes: the per-process secret used when none is configured. */
export function randomIntentSecret(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}
