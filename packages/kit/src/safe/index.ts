// Safe Transaction Service seam (Phase 2 wave 2). A thin wrapper over the
// official Safe Transaction Service endpoint that records a proposed Safe
// transaction with one owner's signature:
//   POST {url}/api/v1/safes/{safe_address}/multisig-transactions/
// Nothing moves on chain here: the Safe's owners still have to reach the
// threshold and execute. The safeTxHash is the EIP-712 hash of the SafeTx.
import { getAddress, hashTypedData } from "viem";
import type { UnsignedTypedData } from "../spec/index.js";
import type { KitFetch } from "../types.js";

/** The fields of the SafeTx EIP-712 type the service expects alongside the signature. */
const SAFE_TX_FIELDS = ["to", "value", "data", "operation", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver", "nonce"] as const;

/** EIP-712 hash of a typed-data payload (for a SafeTx, the safeTxHash). */
export function typedDataHash(td: Pick<UnsignedTypedData, "domain" | "types" | "primaryType" | "message">): `0x${string}` {
  const { EIP712Domain: _d, ...types } = td.types as Record<string, Array<{ name: string; type: string }>>;
  void _d;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (hashTypedData as (p: any) => `0x${string}`)({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
}

/** The service URL for the proposal, from the payload's submit block. */
export function safeProposalUrl(submit: NonNullable<UnsignedTypedData["submit"]>): string {
  return `${submit.url.replace(/\/+$/, "")}/api/v1/safes/${getAddress(submit.safe_address)}/multisig-transactions/`;
}

/**
 * POSTs the signed SafeTx to the Safe Transaction Service. Returns the
 * safeTxHash it was proposed under. Throws on a non-2xx answer, quoting it.
 */
export async function proposeToSafeTxService(
  td: UnsignedTypedData,
  signature: `0x${string}`,
  opts: { fetch: KitFetch; userAgent?: string; timeoutMs?: number },
): Promise<`0x${string}`> {
  if (!td.submit || td.submit.kind !== "safe_tx_service") throw new Error("typed_data has no safe_tx_service submit block");
  if (td.primaryType !== "SafeTx") throw new Error(`safe_tx_service expects primaryType SafeTx, got ${td.primaryType}`);
  const safeTxHash = typedDataHash(td);
  const m = td.message as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const k of SAFE_TX_FIELDS) {
    if (!(k in m)) throw new Error(`SafeTx message is missing ${k}`);
    const v = m[k];
    body[k] = typeof v === "bigint" ? v.toString() : v;
  }
  body.to = getAddress(String(m.to));
  body.contractTransactionHash = safeTxHash;
  body.sender = getAddress(td.signer);
  body.signature = signature;
  body.origin = "sato-kit";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.userAgent) headers["user-agent"] = opts.userAgent;
  const res = await opts.fetch(safeProposalUrl(td.submit), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) {
    let text = "";
    try { text = (await res.text()).slice(0, 300); } catch { /* body unreadable */ }
    throw new Error(`Safe Transaction Service answered HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return safeTxHash;
}
