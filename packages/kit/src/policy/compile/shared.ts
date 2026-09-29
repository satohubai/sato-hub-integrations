/**
 * Shared, pure helpers for the signer-policy compilers (Privy, Turnkey).
 * No clock, no I/O.
 */
import type { SatoPolicy } from "../../spec/index.js";
import type { NotCompiled } from "./cdp.js";

/** ODA chain -> EVM chain id. Chains missing here (Solana) are not EVM. */
export const EVM_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  sepolia: 11155111,
  base: 8453,
  "base-sepolia": 84532,
  arbitrum: 42161,
  "arbitrum-sepolia": 421614,
  optimism: 10,
  "optimism-sepolia": 11155420,
  polygon: 137,
};

const NATIVE: Record<string, readonly string[]> = { polygon: ["POL", "MATIC"] };
const nativeSymbols = (chain: string) => NATIVE[chain] ?? ["ETH"];
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function split(entry: string): [string, string] {
  const i = entry.indexOf(":");
  return [entry.slice(0, i).toLowerCase(), entry.slice(i + 1)];
}

export type TokenCap = { chain: string; chain_id: number; token: `0x${string}`; max: bigint };

/**
 * One allow group: a transaction is admitted when it matches every set part of
 * one group. `chain_id` null = any chain; `addresses` null = any to.
 * Allowlist entries are chain-qualified, so addresses are grouped per chain:
 * an address allowed on one chain is never admitted on another.
 */
export type AllowGroup = { chain_id: number | null; addresses: `0x${string}`[] | null; nativeCap: bigint | null };

export type Plan = {
  /** Empty = deny every transaction (never widened to "any"). */
  groups: AllowGroup[];
  tokenCaps: TokenCap[];
  not: NotCompiled[];
};

/** The part of every EVM signer compiler that reads the policy. */
export function plan(policy: SatoPolicy, signer: string, network?: string): Plan {
  const not: NotCompiled[] = [];
  let chains = policy.allow_chains.map((c) => c.toLowerCase());
  if (network) {
    network = network.toLowerCase();
    if (chains.length > 0 && !chains.includes(network)) {
      // An allowlist that excludes the target network is an explicitly empty
      // scope: deny every transaction, never read it as "no allowlist".
      not.push({ field: "allow_chains", reason: `The target network ${network} is outside allow_chains; no transaction is allowed.` });
      return { groups: [], tokenCaps: [], not };
    }
    chains = [network];
  }
  const unmapped = [...chains].sort().filter((c) => EVM_CHAIN_IDS[c] === undefined);
  if (unmapped.length) not.push({ field: "allow_chains", reason: `${signer} EVM policy has no chain id for: ${unmapped.join(", ")}.` });
  const inScope = (c: string) => chains.length === 0 || chains.includes(c);
  const scopeIds = [...new Set(chains.map((c) => EVM_CHAIN_IDS[c]).filter((x): x is number => x !== undefined))].sort((a, b) => a - b);

  // chain-qualified addresses, grouped per chain id
  const byChain = new Map<number, Set<string>>();
  for (const field of ["allow_contracts", "allow_recipients"] as const) {
    const skipped: string[] = [];
    for (const e of policy[field]) {
      const [c, a] = split(e);
      if (!inScope(c)) continue;
      const id = EVM_CHAIN_IDS[c];
      if (id !== undefined && ADDRESS_RE.test(a)) {
        if (!byChain.has(id)) byChain.set(id, new Set());
        byChain.get(id)!.add(a.toLowerCase());
      } else skipped.push(e);
    }
    if (skipped.length) not.push({ field, reason: `Entries that are not 0x addresses on an EVM chain cannot be matched against the transaction's to: ${skipped.join(", ")}.` });
  }
  if (policy.allow_recipients.length > 0) {
    not.push({ field: "allow_recipients", reason: "The allowlist matches the transaction's to; a token recipient encoded in calldata is not checked by this document." });
  }
  if (policy.allow_contracts.length > 0 && policy.allow_recipients.length > 0) {
    not.push({ field: "allow_contracts", reason: `Contracts and recipients compile into one to-address list per chain; ${signer} cannot tell the two roles apart here.` });
  }

  // native caps per chain id
  const nativeCaps = new Map<number, bigint>();
  const tokenCaps: TokenCap[] = [];
  const symbolCaps: string[] = [];
  const unscopedCaps: string[] = [];
  for (const k of Object.keys(policy.max_per_trade).sort()) {
    const [c, t] = split(k);
    if (!inScope(c)) continue;
    const v = BigInt(policy.max_per_trade[k]!);
    const id = EVM_CHAIN_IDS[c];
    if (id !== undefined && nativeSymbols(c).includes(t.toUpperCase())) {
      const prev = nativeCaps.get(id);
      nativeCaps.set(id, prev === undefined || v < prev ? v : prev);
      unscopedCaps.push(k);
    } else if (id !== undefined && ADDRESS_RE.test(t)) {
      tokenCaps.push({ chain: c, chain_id: id, token: t.toLowerCase() as `0x${string}`, max: v });
    } else symbolCaps.push(k);
  }
  if (symbolCaps.length) not.push({ field: "max_per_trade", reason: `A cap needs a native symbol or the token's 0x address on an EVM chain; not compiled: ${symbolCaps.join(", ")}.` });
  if (tokenCaps.length) not.push({ field: "max_per_trade", reason: "ERC-20 caps cover transfer(recipient, amount) only; transferFrom, approve and swaps through a router are not capped by this document." });
  const minCap = nativeCaps.size ? [...nativeCaps.values()].reduce((m, v) => (v < m ? v : m)) : null;

  const groups: AllowGroup[] = [];
  const listsSet = policy.allow_contracts.length + policy.allow_recipients.length > 0;
  if (listsSet) {
    for (const id of [...byChain.keys()].sort((a, b) => a - b)) {
      groups.push({ chain_id: id, addresses: [...byChain.get(id)!].sort() as `0x${string}`[], nativeCap: nativeCaps.get(id) ?? null });
    }
  } else if (chains.length > 0) {
    for (const id of scopeIds) groups.push({ chain_id: id, addresses: null, nativeCap: nativeCaps.get(id) ?? null });
  } else {
    groups.push({ chain_id: null, addresses: null, nativeCap: minCap });
    if (nativeCaps.size > 1) not.push({ field: "max_per_trade", reason: `With no chain allowlist the native caps collapse to the smallest one on every chain: ${unscopedCaps.join(", ")}.` });
  }
  return { groups, tokenCaps, not };
}

/** Fields no EVM signer policy can express; identical wording across compilers. */
export function commonNotCompiled(policy: SatoPolicy, signer: string): NotCompiled[] {
  const not: NotCompiled[] = [];
  const has = (b: boolean, field: string, reason: string) => { if (b) not.push({ field, reason }); };
  has(policy.allow_tokens.length > 0, "allow_tokens", `${signer} policies here carry no token allowlist; the kit's pre-flight checks it.`);
  has(policy.allow_venues.length > 0, "allow_venues", "A venue is not visible in a transaction; the kit's pre-flight checks it.");
  has(policy.max_usd_per_trade !== null, "max_usd_per_trade", `${signer} conditions carry no USD price; the kit's pre-flight checks it.`);
  has(policy.max_usd_per_day !== null, "max_usd_per_day", `${signer} conditions carry no daily running total here; the kit's pre-flight checks it.`);
  has(policy.max_slippage_bps !== null, "max_slippage_bps", "Slippage is a quote parameter, not a transaction field.");
  not.push({ field: "intent_ttl_s", reason: "Intent lifetime is enforced by the kit's intent store, not the signer." });
  not.push({ field: "unknown_verdict", reason: "A pre-flight reading; the signer has no notion of an unreadable fact." });
  not.push({ field: "require_simulation", reason: `The kit simulates before handing a transaction to the signer; ${signer} conditions do not require it.` });
  has(policy.human_approval, "human_approval", "Human approval is a signer mode (human-approve), not a compiled condition.");
  has(policy.network !== "mainnet", "network", `Policy network is ${policy.network}; the signer cannot tell a fork from its target chain id, so use a testnet or fork wallet.`);
  return not;
}

export function sortNot(not: NotCompiled[]): NotCompiled[] {
  return not.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
}
