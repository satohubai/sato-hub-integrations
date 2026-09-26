// SIGNER builder. Local viem account; fork/testnet by default.
import type { RpcProvider, Signer } from "../types.js";

export type ViemLocalSignerOptions =
  | { privateKey: `0x${string}`; generate?: false; rpc: RpcProvider }
  | { generate: true; privateKey?: undefined; rpc: RpcProvider };

export function viemLocalSigner(_opts: ViemLocalSignerOptions): Signer {
  throw new Error("not implemented: viemLocalSigner");
}
