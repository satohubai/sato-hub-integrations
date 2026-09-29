// ACTIONS builder (K4). The Solana action set, in a stable order, and its exports.
import type { AnyAction } from "../types.js";
import { solanaReadAction } from "./solana_read.js";
import { solanaTransferAction } from "./solana_transfer.js";
import { solanaSwapPrepareAction, solanaSwapQuoteAction } from "./solana_swap.js";

export function solanaActions(): readonly AnyAction[] {
  return [solanaReadAction(), solanaTransferAction(), solanaSwapQuoteAction(), solanaSwapPrepareAction()];
}

export { solanaReadDescriptor, solanaReadAction, solanaRead, SOLANA_READ_KINDS } from "./solana_read.js";
export type { SolanaReadKind, SolanaReadOutput } from "./solana_read.js";
export { solanaTransferDescriptor, solanaTransferAction, buildSolanaTransfer } from "./solana_transfer.js";
export type { SolanaTransferParams } from "./solana_transfer.js";
export {
  solanaSwapQuoteDescriptor, solanaSwapQuoteAction, solanaSwapQuote, solanaSwapPrepareDescriptor, solanaSwapPrepareAction,
  buildSolanaSwapPrepare, deriveSolanaUsd, SOLANA_SWAP_NOTE,
} from "./solana_swap.js";
export type { SolanaSwapQuoteOutput, SolanaSwapPrepareParams } from "./solana_swap.js";
export { SOLANA_SWAP_VENUES, SOLANA_STABLECOINS, JUPITER_BASE_URL, SATO_SWAP_QUOTE_URL, NO_SATO_FEE_SOLANA } from "./_solana.js";
export type { SolanaSwapQuote, SolanaSwapVenue } from "./_solana.js";
