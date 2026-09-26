/**
 * POLICY builder — compiles a sato.policy/v1 into a CDP Server Wallet v2
 * Policy Engine document (the shape `cdp.policies.createPolicy({ policy })`
 * takes: scope, description, rules[{ action, operation, criteria[] }]).
 *
 * The signer enforces this document; the kit's pre-flight only explains.
 *
 * What maps:
 *   - allow_chains            -> `evmNetwork` criterion on sendEvmTransaction
 *                                 (signEvmTransaction carries no network, so it
 *                                 is not scoped by chain; listed in not_compiled)
 *   - allow_contracts + allow_recipients (0x addresses)
 *                             -> one `evmAddress` "in" criterion on the tx `to`.
 *                                 CDP reads `to`, so a token recipient inside
 *                                 calldata is not covered — that is stated too.
 *   - max_per_trade native entries ("<chain>:ETH" / "<chain>:POL" / "<chain>:MATIC")
 *                             -> `ethValue` "<=" criterion (wei).
 * Every other field that carries a constraint is returned in `not_compiled`
 * with the reason. Nothing is silently dropped.
 *
 * CDP evaluates accept rules; a transaction that matches no accept rule is
 * rejected. Pure: no clock, no I/O.
 */
import type { OdaChain, SatoPolicy } from "../../spec/index.js";

export type CdpCriterion =
  | { type: "ethValue"; ethValue: string; operator: "<=" }
  | { type: "evmAddress"; addresses: `0x${string}`[]; operator: "in" }
  | { type: "evmNetwork"; networks: string[]; operator: "in" };

export type CdpRule = {
  action: "accept" | "reject";
  operation: "signEvmTransaction" | "sendEvmTransaction";
  criteria: CdpCriterion[];
};

export type CdpPolicyDocument = { scope: "account" | "project"; description?: string; rules: CdpRule[] };

export type NotCompiled = { field: string; reason: string };

export type CdpCompileResult = { document: CdpPolicyDocument; not_compiled: NotCompiled[] };

/** ODA chain -> CDP evmNetwork name. Chains missing here are not expressible. */
export const CDP_NETWORKS: Partial<Record<OdaChain, string>> = {
  ethereum: "ethereum",
  sepolia: "ethereum-sepolia",
  base: "base",
  "base-sepolia": "base-sepolia",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
};

const NATIVE: Record<string, readonly string[]> = {
  polygon: ["POL", "MATIC"],
};
const nativeSymbols = (chain: string) => NATIVE[chain] ?? ["ETH"];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function split(entry: string): [string, string] {
  const i = entry.indexOf(":");
  return [entry.slice(0, i).toLowerCase(), entry.slice(i + 1)];
}

export function compileCdpPolicy(
  policy: SatoPolicy,
  opts: { address: `0x${string}`; network?: OdaChain },
): CdpCompileResult {
  const not: NotCompiled[] = [];

  // chain scope
  let chains = policy.allow_chains.map((c) => c.toLowerCase());
  if (opts.network) chains = chains.length === 0 || chains.includes(opts.network) ? [opts.network] : [];
  const networks: string[] = [];
  const unmapped: string[] = [];
  for (const c of [...chains].sort()) {
    const n = CDP_NETWORKS[c as OdaChain];
    if (n) networks.push(n);
    else unmapped.push(c);
  }
  if (unmapped.length) not.push({ field: "allow_chains", reason: `CDP evmNetwork has no equivalent for: ${unmapped.join(", ")}.` });
  if (chains.length > 0) not.push({ field: "allow_chains", reason: "signEvmTransaction takes no evmNetwork criterion; the chain limit applies to sendEvmTransaction only." });
  const inScope = (c: string) => chains.length === 0 || chains.includes(c);

  // addresses
  const addrs = new Set<string>();
  for (const field of ["allow_contracts", "allow_recipients"] as const) {
    const skipped: string[] = [];
    for (const e of policy[field]) {
      const [c, a] = split(e);
      if (!inScope(c)) continue;
      if (ADDRESS_RE.test(a)) addrs.add(a.toLowerCase());
      else skipped.push(e);
    }
    if (skipped.length) not.push({ field, reason: `Entries that are not 0x addresses cannot be an evmAddress criterion: ${skipped.join(", ")}.` });
  }
  if (policy.allow_recipients.length > 0) {
    not.push({ field: "allow_recipients", reason: "evmAddress matches the transaction's `to`; a token recipient encoded in calldata is not checked by this document." });
  }
  // A combined list: with both lists set, a contract address also passes as a recipient and vice versa.
  if (policy.allow_contracts.length > 0 && policy.allow_recipients.length > 0) {
    not.push({ field: "allow_contracts", reason: "Contracts and recipients compile into one evmAddress list; CDP cannot tell the two roles apart." });
  }
  const addresses = [...addrs].sort() as `0x${string}`[];

  // native value caps
  let ethCap: bigint | null = null;
  const nonNative: string[] = [];
  for (const k of Object.keys(policy.max_per_trade).sort()) {
    const [c, t] = split(k);
    if (!inScope(c)) continue;
    if (nativeSymbols(c).includes(t.toUpperCase())) {
      const v = BigInt(policy.max_per_trade[k]!); // k comes from Object.keys
      ethCap = ethCap === null || v < ethCap ? v : ethCap;
    } else nonNative.push(k);
  }
  if (nonNative.length) not.push({ field: "max_per_trade", reason: `ethValue caps native value only; token caps not compiled: ${nonNative.join(", ")}.` });

  const base: CdpCriterion[] = [];
  if (ethCap !== null) base.push({ type: "ethValue", ethValue: ethCap.toString(), operator: "<=" });
  if (addresses.length) base.push({ type: "evmAddress", addresses, operator: "in" });

  const rules: CdpRule[] = [];
  if (chains.length > 0 && networks.length === 0) {
    // every allowed chain is unexpressible: reject rather than widen to any network
    rules.push({ action: "reject", operation: "sendEvmTransaction", criteria: [{ type: "ethValue", ethValue: "0", operator: "<=" }] });
  } else {
    const send: CdpCriterion[] = [...base];
    if (networks.length) send.push({ type: "evmNetwork", networks, operator: "in" });
    rules.push({ action: "accept", operation: "signEvmTransaction", criteria: base });
    rules.push({ action: "accept", operation: "sendEvmTransaction", criteria: send });
  }

  // fields CDP cannot express
  const has = (b: boolean, field: string, reason: string) => { if (b) not.push({ field, reason }); };
  has(policy.allow_tokens.length > 0, "allow_tokens", "CDP criteria have no token allowlist; the kit's pre-flight checks it.");
  has(policy.allow_venues.length > 0, "allow_venues", "A venue is not visible in a transaction; the kit's pre-flight checks it.");
  has(policy.max_usd_per_trade !== null, "max_usd_per_trade", "CDP criteria carry no USD price; the kit's pre-flight checks it.");
  has(policy.max_usd_per_day !== null, "max_usd_per_day", "CDP criteria carry no daily running total; the kit's pre-flight checks it.");
  has(policy.max_slippage_bps !== null, "max_slippage_bps", "Slippage is a quote parameter, not a transaction field.");
  not.push({ field: "intent_ttl_s", reason: "Intent lifetime is enforced by the kit's intent store, not the signer." });
  not.push({ field: "unknown_verdict", reason: "A pre-flight reading; the signer has no notion of an unreadable fact." });
  not.push({ field: "require_simulation", reason: "The kit simulates before handing a transaction to the signer; CDP criteria do not require it." });
  has(policy.human_approval, "human_approval", "Human approval is a signer mode (human-approve), not a CDP criterion.");
  has(policy.network !== "mainnet", "network", `Policy network is ${policy.network}; CDP cannot tell a fork from its target network, so use a testnet or fork account.`);

  not.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : a.reason < b.reason ? -1 : 1));
  return {
    document: { scope: "account", description: `Sato policy for ${opts.address.slice(0, 10)}`, rules },
    not_compiled: not,
  };
}
