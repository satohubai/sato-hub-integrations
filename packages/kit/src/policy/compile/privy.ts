/**
 * POLICY builder — compiles a sato.policy/v1 into a Privy server-wallet policy
 * (the body of `POST /v1/policies`: version, name, chain_type, rules[{ name,
 * method, conditions[{ field_source, field, operator, value, abi? }], action }]).
 *
 * Sources (read when this file was written):
 *   https://docs.privy.io/controls/policies/overview
 *   https://docs.privy.io/controls/policies/example-policies/ethereum
 *
 * The signer enforces this document; the kit's pre-flight only explains.
 * Privy semantics this compiler relies on: a request no rule resolves is
 * DENIED, and a matching DENY rule wins over any ALLOW rule.
 *
 * What maps (chain_type "ethereum", methods eth_signTransaction + eth_sendTransaction):
 *   - allow_chains              -> one ALLOW rule per chain, ethereum_transaction.chain_id "eq"
 *   - allow_contracts + allow_recipients (0x addresses)
 *                               -> ethereum_transaction.to "in", per chain (entries are
 *                                  chain-qualified; an address is never admitted on
 *                                  another chain)
 *   - max_per_trade native      -> ethereum_transaction.value "lte" (wei), per chain
 *   - max_per_trade "<chain>:0x<token>"
 *                               -> a DENY rule: to == token AND chain_id == chain AND
 *                                  ethereum_calldata transfer.amount "gt" cap
 * Every other constraining field is returned in `not_compiled` with the reason.
 * Nothing is silently dropped. An allowed chain set with no EVM chain, or an
 * address list with no expressible address, yields no ALLOW rule (deny-all),
 * never a wider document. Pure: no clock, no I/O.
 */
import type { OdaChain, SatoPolicy } from "../../spec/index.js";
import type { NotCompiled } from "./cdp.js";
import { commonNotCompiled, plan, sortNot } from "./shared.js";

export type PrivyCondition =
  | { field_source: "ethereum_transaction"; field: "to" | "value" | "chain_id"; operator: "in" | "eq" | "lte"; value: string | string[] }
  | { field_source: "ethereum_calldata"; field: "transfer.amount"; operator: "gt"; value: string; abi: readonly unknown[] };

export type PrivyRule = {
  name: string;
  method: "eth_signTransaction" | "eth_sendTransaction";
  conditions: PrivyCondition[];
  action: "ALLOW" | "DENY";
};

export type PrivyPolicyDocument = { version: "1.0"; name: string; chain_type: "ethereum"; rules: PrivyRule[] };

export type PrivyCompileResult = { document: PrivyPolicyDocument; not_compiled: NotCompiled[] };

/** Privy's documented cap on values in one "in" condition. */
export const PRIVY_IN_MAX = 100;

export const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
  },
] as const;

const METHODS = ["eth_signTransaction", "eth_sendTransaction"] as const;

export function compilePrivyPolicy(
  policy: SatoPolicy,
  opts: { address: `0x${string}`; network?: OdaChain },
): PrivyCompileResult {
  const p = plan(policy, "Privy", opts.network);
  const not = [...p.not, ...commonNotCompiled(policy, "Privy")];
  const rules: PrivyRule[] = [];

  let tooMany = false;
  p.groups.forEach((g, i) => {
    if (g.addresses && g.addresses.length > PRIVY_IN_MAX) { tooMany = true; return; }
    const c: PrivyCondition[] = [];
    if (g.chain_id !== null) c.push({ field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: String(g.chain_id) });
    if (g.addresses) c.push({ field_source: "ethereum_transaction", field: "to", operator: "in", value: [...g.addresses] });
    if (g.nativeCap !== null) c.push({ field_source: "ethereum_transaction", field: "value", operator: "lte", value: g.nativeCap.toString() });
    const tag = g.chain_id === null ? "any" : String(g.chain_id);
    for (const m of METHODS) rules.push({ name: `sato-allow-${tag}-${i}-${m}`, method: m, conditions: c, action: "ALLOW" });
  });
  if (tooMany) not.push({ field: "allow_contracts", reason: `Privy "in" takes at most ${PRIVY_IN_MAX} values; a chain whose address list is longer got no ALLOW rule.` });
  if (p.groups.some((g) => g.addresses)) {
    not.push({ field: "allow_contracts", reason: "Privy string comparison is case-sensitive; addresses are written lowercase, so a checksummed to may need the same form." });
  }

  for (const cap of p.tokenCaps) {
    for (const m of METHODS) {
      rules.push({
        name: `sato-cap-${cap.chain}-${cap.token.slice(0, 10)}-${m}`,
        method: m,
        conditions: [
          { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: String(cap.chain_id) },
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: cap.token },
          { field_source: "ethereum_calldata", field: "transfer.amount", operator: "gt", value: "0x" + cap.max.toString(16), abi: ERC20_TRANSFER_ABI },
        ],
        action: "DENY",
      });
    }
  }

  return {
    document: { version: "1.0", name: `Sato policy for ${opts.address.slice(0, 10)}`, chain_type: "ethereum", rules },
    not_compiled: sortNot(not),
  };
}
