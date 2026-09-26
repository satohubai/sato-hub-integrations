// POLICY builder. Compiles a sato.policy/v1 into a CDP server-wallet policy (the enforcing side).
import type { SatoPolicy } from "../../spec/index.js";

export type CdpPolicyDocument = { scope: "account" | "project"; description?: string; rules: unknown[] };

export function compileCdpPolicy(_policy: SatoPolicy, _opts: { address: `0x${string}` }): CdpPolicyDocument {
  throw new Error("not implemented: compileCdpPolicy");
}
