// INTENT builder.
import type { IntentStore } from "../types.js";

export function memoryIntentStore(): IntentStore {
  throw new Error("not implemented: memoryIntentStore");
}

export function fileIntentStore(_dir: string): IntentStore {
  throw new Error("not implemented: fileIntentStore");
}
