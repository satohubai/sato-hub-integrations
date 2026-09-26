// INTENT builder. intent_id / params_digest per the frozen contract in spec/intent.ts.
import type { IntentIdFields } from "../spec/index.js";

export function paramsDigest(_params: unknown): string {
  throw new Error("not implemented: paramsDigest");
}

export function computeIntentId(_secret: Uint8Array, _fields: IntentIdFields): string {
  throw new Error("not implemented: computeIntentId");
}

export function sha256Hex(_s: string): string {
  throw new Error("not implemented: sha256Hex");
}
