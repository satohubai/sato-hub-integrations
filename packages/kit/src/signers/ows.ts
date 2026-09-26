// SIGNER builder. Open Wallet Standard signer.
import type { RpcProvider, Signer } from "../types.js";

export type OwsSignerOptions = { wallet: unknown; rpc?: RpcProvider };

export function owsSigner(_opts: OwsSignerOptions): Signer {
  throw new Error("not implemented: owsSigner");
}
