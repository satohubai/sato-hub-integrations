/**
 * POLICY builder — compiles a sato.policy/v1 into Turnkey policies (each the
 * body of a CREATE_POLICY activity: policyName, effect, condition, notes).
 *
 * Sources (read when this file was written):
 *   https://docs.turnkey.com/concepts/policies/language
 *   https://docs.turnkey.com/concepts/policies/overview
 *
 * The signer enforces these policies; the kit's pre-flight only explains.
 * Turnkey semantics this compiler relies on: an activity no policy allows is
 * denied, and an explicit EFFECT_DENY wins over any EFFECT_ALLOW.
 *
 * What maps (eth.tx.* conditions):
 *   - allow_chains              -> one EFFECT_ALLOW policy per chain, eth.tx.chain_id == <id>
 *   - allow_contracts + allow_recipients (0x addresses)
 *                               -> eth.tx.to in [...], per chain (entries are
 *                                  chain-qualified; an address is never admitted on
 *                                  another chain)
 *   - max_per_trade native      -> eth.tx.value <= <wei>, per chain
 *   - max_per_trade "<chain>:0x<token>"
 *                               -> an EFFECT_DENY policy: to == token AND chain_id == chain
 *                                  AND function_name == 'transfer' AND
 *                                  contract_call_args['amount'] > cap. Turnkey fills
 *                                  function_name / contract_call_args only when an
 *                                  ERC-20 Smart Contract Interface is uploaded for the
 *                                  token; that is listed in not_compiled.
 * Every other constraining field is returned in `not_compiled` with the reason.
 * Nothing is silently dropped. An allowed chain set with no EVM chain, or an
 * address list with no expressible address, yields no EFFECT_ALLOW policy
 * (deny-all), never a wider one. Pure: no clock, no I/O.
 */
import type { OdaChain, SatoPolicy } from "../../spec/index.js";
import type { NotCompiled } from "./cdp.js";
import { commonNotCompiled, plan, sortNot } from "./shared.js";

export type TurnkeyPolicy = {
  policyName: string;
  effect: "EFFECT_ALLOW" | "EFFECT_DENY";
  condition: string;
  notes: string;
};

export type TurnkeyPolicyDocument = { policies: TurnkeyPolicy[] };

export type TurnkeyCompileResult = { document: TurnkeyPolicyDocument; not_compiled: NotCompiled[] };

const list = (xs: readonly (string | number)[]) =>
  "[" + xs.map((x) => (typeof x === "number" ? String(x) : `'${x}'`)).join(", ") + "]";

export function compileTurnkeyPolicy(
  policy: SatoPolicy,
  opts: { address: `0x${string}`; network?: OdaChain },
): TurnkeyCompileResult {
  const p = plan(policy, "Turnkey", opts.network);
  const not = [...p.not, ...commonNotCompiled(policy, "Turnkey")];
  const who = opts.address.slice(0, 10);
  const policies: TurnkeyPolicy[] = [];

  for (const g of p.groups) {
    const parts: string[] = [];
    if (g.chain_id !== null) parts.push(`eth.tx.chain_id == ${g.chain_id}`);
    if (g.addresses) parts.push(`eth.tx.to in ${list(g.addresses)}`);
    if (g.nativeCap !== null) parts.push(`eth.tx.value <= ${g.nativeCap.toString()}`);
    // An EFFECT_ALLOW needs a condition; with nothing to constrain, allow every EVM transaction.
    if (parts.length === 0) parts.push("eth.tx.to != ''");
    policies.push({
      policyName: `Sato policy for ${who}: allow ${g.chain_id ?? "any chain"}`,
      effect: "EFFECT_ALLOW",
      condition: parts.join(" && "),
      notes: "Compiled from sato.policy/v1. Scope it to the agent's user or wallet when creating it.",
    });
  }

  for (const cap of p.tokenCaps) {
    policies.push({
      policyName: `Sato policy for ${who}: cap ${cap.chain}:${cap.token}`,
      effect: "EFFECT_DENY",
      condition:
        `eth.tx.chain_id == ${cap.chain_id} && eth.tx.to == '${cap.token}' && ` +
        `eth.tx.function_name == 'transfer' && eth.tx.contract_call_args['amount'] > ${cap.max.toString()}`,
      notes: "Denies an ERC-20 transfer above the cap. Needs an ERC-20 Smart Contract Interface uploaded for this token.",
    });
  }
  if (p.tokenCaps.length) {
    not.push({ field: "max_per_trade", reason: "Turnkey parses contract_call_args only when a Smart Contract Interface is uploaded for the token; without it the ERC-20 cap policy does not match." });
  }

  return { document: { policies }, not_compiled: sortNot(not) };
}
