// ACTIONS builder. The core action set, in a stable order.
import type { AnyAction } from "../types.js";
import { chainReadAction } from "./chain_read.js";
import { erc8004LookupAction } from "./erc8004_lookup.js";
import { swapPrepareAction } from "./swap_prepare.js";
import { swapQuoteAction } from "./swap_quote.js";
import { txSimulateAction } from "./tx_simulate.js";
import { bridgeQuoteAction } from "./bridge_quote.js";
import { bridgePrepareAction } from "./bridge_prepare.js";
import { x402PrepareAction } from "./x402_prepare.js";

export function coreActions(): readonly AnyAction[] {
  return [chainReadAction(), swapQuoteAction(), swapPrepareAction(), x402PrepareAction(), erc8004LookupAction(), txSimulateAction(),
    bridgeQuoteAction(), bridgePrepareAction()];
}

/** Lazily built so importing the module never throws. */
export const CORE_ACTIONS: { readonly list: () => readonly AnyAction[] } = { list: () => coreActions() };
