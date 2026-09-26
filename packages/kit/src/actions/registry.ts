// ACTIONS builder. The core action set, in a stable order.
import type { AnyAction } from "../types.js";

export function coreActions(): readonly AnyAction[] {
  throw new Error("not implemented: coreActions");
}

/** Lazily built so importing the module never throws while stubs are in place. */
export const CORE_ACTIONS: { readonly list: () => readonly AnyAction[] } = { list: () => coreActions() };
