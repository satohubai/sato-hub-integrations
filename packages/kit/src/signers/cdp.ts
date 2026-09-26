// SIGNER builder. Coinbase CDP server wallet (optional peer @coinbase/cdp-sdk).
import type { Signer } from "../types.js";

export type CdpSignerOptions = { account: unknown };

export function cdpSigner(_opts: CdpSignerOptions): Signer {
  throw new Error("not implemented: cdpSigner");
}
