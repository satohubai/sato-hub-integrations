/**
 * POLICY builder — compiles a sato.policy/v1 into a CDP Server Wallet v2
 * Policy Engine document (the shape `cdp.policies.createPolicy({ policy })`
 * takes: scope, description, rules[{ action, operation, criteria[] }]).
 *
 * The signer enforces this document; the kit's pre-flight only explains.
 *
 * What maps:
 *   One sendEvmTransaction accept rule PER CHAIN (planned by compile/shared.ts):
 *   - allow_chains            -> that rule's `evmNetwork` criterion (one network)
 *   - allow_contracts + allow_recipients (0x addresses)
 *                             -> that chain's `evmAddress` "in" criterion on the
 *                                 tx `to`. An address allowed on one chain is
 *                                 never admitted on another. CDP reads `to`, so a
 *                                 token recipient inside calldata is not covered.
 *   - max_per_trade native entries ("<chain>:ETH" / "<chain>:POL" / "<chain>:MATIC")
 *                             -> that chain's `ethValue` "<=" criterion (wei).
 *   signEvmTransaction carries no network, so a sign rule is emitted only when
 *   the policy is chain-agnostic; otherwise signing is not accepted (fail closed).
 * Every other field that carries a constraint is returned in `not_compiled`
 * with the reason. Nothing is silently dropped.
 *
 * CDP evaluates accept rules; a transaction that matches no accept rule is
 * rejected. Pure: no clock, no I/O.
 */
import type { OdaChain, SatoPolicy } from "../../spec/index.js";
import { commonNotCompiled, EVM_CHAIN_IDS, plan, sortNot } from "./shared.js";

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

/** EVM chain id -> CDP evmNetwork name. */
const CDP_BY_ID = new Map<number, string>(
  (Object.entries(CDP_NETWORKS) as [string, string][]).map(([c, n]) => [EVM_CHAIN_IDS[c]!, n]),
);

export function compileCdpPolicy(
  policy: SatoPolicy,
  opts: { address: `0x${string}`; network?: OdaChain },
): CdpCompileResult {
  const pl = plan(policy, "CDP", opts.network);
  // plan's ERC-20 cap wording describes Privy/Turnkey; CDP compiles no token caps.
  const not: NotCompiled[] = pl.not.filter((x) => !(x.field === "max_per_trade" && x.reason.startsWith("ERC-20 caps")));
  if (pl.tokenCaps.length) {
    not.push({ field: "max_per_trade", reason: `ethValue caps native value only; token caps not compiled: ${pl.tokenCaps.map((t) => `${t.chain}:${t.token}`).join(", ")}.` });
  }

  const rules: CdpRule[] = [];
  const noNetwork: string[] = [];
  for (const g of pl.groups) {
    const criteria: CdpCriterion[] = [];
    if (g.nativeCap !== null) criteria.push({ type: "ethValue", ethValue: g.nativeCap.toString(), operator: "<=" });
    if (g.addresses) criteria.push({ type: "evmAddress", addresses: g.addresses, operator: "in" });
    if (g.chain_id !== null) {
      const n = CDP_BY_ID.get(g.chain_id);
      if (!n) { noNetwork.push(String(g.chain_id)); continue; }
      criteria.push({ type: "evmNetwork", networks: [n], operator: "in" });
    }
    rules.push({ action: "accept", operation: "sendEvmTransaction", criteria });
  }
  if (noNetwork.length) not.push({ field: "allow_chains", reason: `CDP evmNetwork has no equivalent for chain id: ${noNetwork.join(", ")}; those chains are not allowed.` });

  const chainAgnostic = pl.groups.length === 1 && pl.groups[0]!.chain_id === null;
  if (chainAgnostic) {
    rules.unshift({ action: "accept", operation: "signEvmTransaction", criteria: rules[0]!.criteria.filter((c) => c.type !== "evmNetwork") });
  } else {
    not.push({ field: "allow_chains", reason: "signEvmTransaction takes no evmNetwork criterion, so with a chain-scoped policy signing is not accepted; use sendEvmTransaction." });
  }
  if (rules.length === 0) {
    // nothing expressible: reject rather than widen to any network
    rules.push({ action: "reject", operation: "sendEvmTransaction", criteria: [{ type: "ethValue", ethValue: "0", operator: "<=" }] });
  }

  not.push(...commonNotCompiled(policy, "CDP"));
  return {
    document: { scope: "account", description: `Sato policy for ${opts.address.slice(0, 10)}`, rules },
    not_compiled: sortNot(not),
  };
}
