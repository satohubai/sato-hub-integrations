// INTENT builder. prepare -> execute; execute takes only { intent_id }.
import type { CreateKitOptions, Kit } from "./types.js";

export function createKit(_opts: CreateKitOptions): Kit {
  throw new Error("not implemented: createKit");
}
