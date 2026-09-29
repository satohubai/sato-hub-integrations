// SIGNER builder. Human-approve mode: wraps any signer behind an approval callback.
/**
 * `humanApprove(inner, approve)` asks `approve(summary)` before every signature
 * and refuses unless it resolves exactly `true`. A rejection, a thrown error or
 * any other value is a refusal. Enforcement of what gets signed still lives in
 * the inner signer; this wrapper adds a person to the loop.
 */
import type { OdaChain, UnsignedEvmTx, UnsignedSolanaTx } from "../spec/index.js";
import type { Signer, TypedDataInput } from "../types.js";

export type ApprovalSummary =
  | { kind: "evm_tx"; signer: Signer["kind"]; tx: UnsignedEvmTx }
  | { kind: "typed_data"; signer: Signer["kind"]; typed_data: TypedDataInput }
  | { kind: "solana_tx"; signer: Signer["kind"]; tx: UnsignedSolanaTx };

export type ApproveFn = (summary: ApprovalSummary) => Promise<boolean>;

export class ApprovalRefusedError extends Error {
  constructor(what: string) {
    super(`human-approve: ${what} was not approved`);
    this.name = "ApprovalRefusedError";
  }
}

async function approved(approve: ApproveFn, s: ApprovalSummary): Promise<boolean> {
  try {
    return (await approve(s)) === true;
  } catch {
    return false;
  }
}

export function humanApprove(inner: Signer, approve: ApproveFn): Signer {
  if (!inner || typeof approve !== "function") throw new Error("humanApprove: inner signer and approve() are required");
  const s: Signer = {
    kind: "human-approve",
    address: (chain: OdaChain) => inner.address(chain),
    async sendTransaction(tx: UnsignedEvmTx) {
      if (!(await approved(approve, { kind: "evm_tx", signer: inner.kind, tx }))) throw new ApprovalRefusedError("transaction");
      return inner.sendTransaction(tx);
    },
    async signTypedData(td: TypedDataInput) {
      if (!(await approved(approve, { kind: "typed_data", signer: inner.kind, typed_data: td }))) {
        throw new ApprovalRefusedError("typed data");
      }
      return inner.signTypedData(td);
    },
  };
  // The optional Solana capabilities are exposed only when the inner signer has them, each behind approval.
  const innerSign = inner.signSolanaTransaction?.bind(inner);
  const innerSend = inner.sendSolanaTransaction?.bind(inner);
  if (innerSign) {
    s.signSolanaTransaction = async (tx: UnsignedSolanaTx) => {
      if (!(await approved(approve, { kind: "solana_tx", signer: inner.kind, tx }))) throw new ApprovalRefusedError("Solana transaction");
      return innerSign(tx);
    };
  }
  if (innerSend) {
    s.sendSolanaTransaction = async (tx: UnsignedSolanaTx) => {
      if (!(await approved(approve, { kind: "solana_tx", signer: inner.kind, tx }))) throw new ApprovalRefusedError("Solana transaction");
      return innerSend(tx);
    };
  }
  if (inner.nativePolicy) s.nativePolicy = inner.nativePolicy;
  return s;
}
