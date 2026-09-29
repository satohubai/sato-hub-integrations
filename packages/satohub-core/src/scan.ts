// Sato Scan, the part that runs in your agent's own signing path.
//
// Three things, none of which signs, holds or moves anything:
//
//   scanRecipient        offline and pure. Reads a payment's recipient and token against the
//                        addresses you already know and the stablecoin table shipped in this
//                        package. It is a PRE-FLIGHT: it refuses what it can prove locally and
//                        says "unknown" for everything else. Enforcement lives in the signer
//                        that calls it, not here.
//   sanitizeTransfers    drops transfer rows whose token address is not the canonical contract
//                        but whose symbol or name claims a stablecoin.
//   checkRecipientHosted opt-in call to POST /api/scan/recipient for the full reading (watchlist,
//                        declared payTo history, marks). Fails open: a failed call is "unknown".
//
// Look-alike rule, ported exactly from lib/scan/lookalike.ts in the Sato Hub app: a DIFFERENT
// address that agrees with a known one on the first >= 3 and the last >= 3 characters, and on
// >= 7 in total. EVM addresses are compared after "0x", lowercased; Solana base58 is
// case-sensitive. `parity` tests in test/scan.test.ts pin the vectors.
//
// A reading that finds nothing describes what was and was not looked at. It is never a statement
// that an address, a token or a recipient is fine.

import { SatoHubClient, SatoHttpError, type SatoHubClientOptions, type SatoResponse, type SignatureCheck } from "./client.js";
import { SCAN_CONFUSABLES, SCAN_FAMILY_FORMS, SCAN_PRE_NFKC, SCAN_STABLES, SCAN_TABLE_AS_OF, type ScanTableKind } from "./scanTable.js";

// ── types ────────────────────────────────────────────────────────────────────

export type ScanVerdict = "go" | "caution" | "no" | "unknown";

/** Detector numbers of the look-alike rule. Defaults are the app's DEFAULT_DETECTOR_PARAMS. */
export type ScanDetectorParams = {
  prefix_min: number;
  suffix_min: number;
  total_min: number;
  solana_prefix_min: number;
  solana_suffix_min: number;
};

export const SCAN_DETECTOR_PARAMS: Readonly<ScanDetectorParams> = Object.freeze({
  prefix_min: 3,
  suffix_min: 3,
  total_min: 7,
  solana_prefix_min: 3,
  solana_suffix_min: 3,
});

/** Largest value a param may take: an address body is 40 hex characters (EVM) or up to 44 base58 (Solana). */
const PARAM_MAX: Record<keyof ScanDetectorParams, number> = {
  prefix_min: 40,
  suffix_min: 40,
  total_min: 80,
  solana_prefix_min: 44,
  solana_suffix_min: 44,
};

/**
 * Caller params, sanitised. A number is used only when it is a whole number, at least 1 and no
 * larger than the address body it counts characters of (40 EVM, 44 Solana, 80 for the total); an
 * undefined, NaN, Infinity, zero, negative, fractional, oversized or non-number value uses the
 * default for that field and says so. A bad value can only make the rule as strict as the default, never looser: `0`
 * would make every address a look-alike of every other, `NaN` would compare false and make none.
 */
export function resolveDetectorParams(params: unknown): { params: ScanDetectorParams; notes: string[] } {
  const out: ScanDetectorParams = { ...SCAN_DETECTOR_PARAMS };
  const notes: string[] = [];
  if (params === undefined || params === null) return { params: out, notes };
  if (typeof params !== "object" || Array.isArray(params)) {
    notes.push("The look-alike params were not an object; every value used its default.");
    return { params: out, notes };
  }
  const given = params as Record<string, unknown>;
  for (const key of Object.keys(SCAN_DETECTOR_PARAMS) as (keyof ScanDetectorParams)[]) {
    const v = given[key];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= PARAM_MAX[key]) out[key] = v;
    else notes.push(`The look-alike param ${key} was not a whole number from 1 to ${PARAM_MAX[key]}; the default (${SCAN_DETECTOR_PARAMS[key]}) was used.`);
  }
  return { params: out, notes };
}

/**
 * The `scan` block of a generated policy.json (sato.policy/v1, additive).
 *
 * What scanRecipient reads: `lookalike`, `token`, `treasury_recipients`. What it does not:
 * `payto_changed` is recorded in policy.json but enforced only by hosts that implement it: a
 * changed x402 payTo needs the payee's earlier value, which this offline pre-flight is not given,
 * so it does not enforce it today. `hosted_check` is a signal for
 * YOUR code (call checkRecipientHosted when true); scanRecipient never makes a network call.
 * An undefined, misspelt or wrong-typed value falls back to the default for that field,
 * never to "off".
 */
export type ScanPolicy = {
  lookalike?: "refuse" | "caution" | "off";
  token?: "refuse_not_canonical" | "off";
  payto_changed?: "caution" | "refuse" | "off";
  treasury_recipients?: "allowlist_only" | "off";
  hosted_check?: boolean;
};

export const SCAN_POLICY_DEFAULTS = {
  lookalike: "refuse",
  token: "refuse_not_canonical",
  payto_changed: "caution",
  treasury_recipients: "allowlist_only",
  hosted_check: false,
} as const satisfies Required<ScanPolicy>;

const POLICY_MODES = {
  lookalike: ["refuse", "caution", "off"],
  token: ["refuse_not_canonical", "off"],
  payto_changed: ["caution", "refuse", "off"],
  treasury_recipients: ["allowlist_only", "off"],
} as const;

/**
 * Read a `scan` block that may be hand-edited or partial. Each field is checked on its own: a
 * missing field, `undefined`, or a value outside its enum uses the default for that field, and
 * says so in `notes`. A bad value is never read as "off".
 */
export function resolveScanPolicy(policy: unknown): { policy: Required<ScanPolicy>; notes: string[] } {
  const out: Required<ScanPolicy> = { ...SCAN_POLICY_DEFAULTS };
  const notes: string[] = [];
  if (policy === undefined || policy === null) return { policy: out, notes };
  if (typeof policy !== "object" || Array.isArray(policy)) {
    notes.push("The policy `scan` block was not an object; every field used its default.");
    return { policy: out, notes };
  }
  const given = policy as Record<string, unknown>;
  for (const key of Object.keys(POLICY_MODES) as (keyof typeof POLICY_MODES)[]) {
    const v = given[key];
    if (v === undefined) continue;
    if (typeof v === "string" && (POLICY_MODES[key] as readonly string[]).includes(v)) (out as Record<string, unknown>)[key] = v;
    else notes.push(`The policy value scan.${key} was not one of ${POLICY_MODES[key].join(" | ")}; the default "${SCAN_POLICY_DEFAULTS[key]}" was used.`);
  }
  if (given.hosted_check !== undefined) {
    if (typeof given.hosted_check === "boolean") out.hosted_check = given.hosted_check;
    else notes.push("The policy value scan.hosted_check was not true or false; the default (false) was used.");
  }
  return { policy: out, notes };
}

/** A token as the caller knows it. The address decides; symbol and name are only labels. */
export type ScanToken = {
  address: string;
  symbol?: string | null;
  name?: string | null;
  /** The stablecoin family the caller says this is, e.g. "USDC". Wins over the label. */
  family?: string | null;
};

export type ScanRecipientInput = {
  chain: string;
  to: string;
  /** A contract or mint address, or the token as the caller knows it. Omit for a native-coin payment. */
  token?: string | ScanToken | null;
  /**
   * Addresses the agent has paid or been paid by. Look-alikes are matched against these. Each is
   * a raw address, or chain-qualified as `<chain>:<address>`; a qualified entry for a different
   * chain than `chain` is ignored.
   */
  book: readonly string[];
  /**
   * The addresses the policy allows paying: paste `allow_recipients` from policy.json as it is.
   * Entries there are chain-qualified (`base:0x...`); only those for `chain` are used, the rest
   * are ignored. A raw address (no `<chain>:`) is accepted and applies to `chain`. Also matched
   * for look-alikes.
   */
  allowRecipients?: readonly string[];
  params?: Partial<ScanDetectorParams>;
  /** Treasury mode: `to` must be in `allowRecipients`. */
  treasury?: boolean;
  /** The `scan` block of policy.json. Defaults to SCAN_POLICY_DEFAULTS. */
  policy?: ScanPolicy;
};

export type ScanFinding = {
  rule: string;
  verdict: "no" | "caution";
  reason: string;
  limit: string;
  observed: Record<string, unknown>;
};

export type ScanRecipientResult = {
  verdict: ScanVerdict;
  /** The rule that decided, or "scan.go" / "scan.unknown" when nothing refused. */
  rule: string;
  reason: string;
  /** What was seen, for the deciding rule. Empty when nothing decided. */
  observed: Record<string, unknown>;
  /** The threshold or condition the rule applies. Empty string when nothing decided. */
  limit: string;
  /** Every refusal or caution that fired, deciding one first. */
  findings: ScanFinding[];
  /** What was checked, what was skipped and why. */
  notes: string[];
  table_as_of: string;
};

export const RULE_LOOKALIKE = "recipient.lookalike";
export const RULE_LOOKALIKE_IN_BOOK = "recipient.lookalike_in_book";
export const RULE_TOKEN = "token.not_canonical";
export const RULE_NOT_ALLOWLISTED = "recipient.not_allowlisted";
export const RULE_MALFORMED = "recipient.malformed";

// ── chains and addresses ─────────────────────────────────────────────────────

type Vm = "evm" | "solana" | "lightning";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const CHAIN_ALIASES: Record<string, string> = {
  bsc: "bnbchain",
  bnb: "bnbchain",
  eth: "ethereum",
  mainnet: "ethereum",
  arb: "arbitrum",
  op: "optimism",
  avax: "avalanche",
  matic: "polygon",
  sol: "solana",
};

function chainKey(chain: string): string {
  const k = (chain ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  return CHAIN_ALIASES[k] ?? k;
}

function vmOf(chain: string): Vm {
  const k = chainKey(chain);
  if (k === "solana") return "solana";
  if (k === "lightning") return "lightning";
  return "evm";
}

/** Lowercase an EVM address (0x + 40 hex); leave Solana base58 and anything else as given, trimmed. */
function normAddress(chain: string, a: string): string {
  const t = (a ?? "").trim();
  if (vmOf(chain) === "evm" && EVM_ADDRESS.test(t)) return t.toLowerCase();
  return t;
}

const QUALIFIED = /^([A-Za-z][A-Za-z0-9-]{0,39}):(.+)$/;

/**
 * Entries for `chain` only, as raw addresses. `base:0x..` is kept for Base and dropped for
 * Solana; a raw address (no chain prefix) is kept as given. Also reports how many were skipped.
 */
function forChain(chain: string, list: readonly string[] | undefined): { addresses: string[]; skipped: number } {
  const addresses: string[] = [];
  let skipped = 0;
  for (const raw of list ?? []) {
    const t = String(raw ?? "").trim();
    if (!t) continue;
    const m = QUALIFIED.exec(t);
    if (!m) {
      addresses.push(t);
      continue;
    }
    if (chainKey(m[1]!) === chainKey(chain)) addresses.push(m[2]!.trim());
    else skipped++;
  }
  return { addresses, skipped };
}

/** The part of an address a wallet abbreviates: hex after 0x on EVM, the whole string otherwise. */
function body(a: string): string {
  return /^0x/i.test(a) ? a.slice(2).toLowerCase() : a;
}

/** How many leading and trailing characters two addresses share. EVM is compared after 0x. */
function commonAffix(a: string, b: string): { prefix: number; suffix: number } {
  const x = body(a);
  const y = body(b);
  const n = Math.min(x.length, y.length);
  let prefix = 0;
  while (prefix < n && x[prefix] === y[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && x[x.length - 1 - suffix] === y[y.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

export type LookalikeHit = {
  /** The address that was asked about, normalised. */
  address: string;
  /** The known address it resembles. */
  imitates: string;
  prefix: number;
  suffix: number;
  source: "book" | "allowRecipients";
};

/**
 * Every known address `candidate` resembles, one hit per imitated address, most matching
 * characters first. Both ends must clear their minimum, together `total_min`, and the candidate
 * must be a different address. Lightning has no address form to compare and returns [].
 */
export function lookalikes(
  chain: string,
  candidate: string,
  known: readonly { address: string; source: LookalikeHit["source"] }[],
  params: Partial<ScanDetectorParams> = {},
): LookalikeHit[] {
  const vm = vmOf(chain);
  if (vm === "lightning") return [];
  const p = resolveDetectorParams(params).params;
  const prefixMin = vm === "solana" ? p.solana_prefix_min : p.prefix_min;
  const suffixMin = vm === "solana" ? p.solana_suffix_min : p.suffix_min;
  const cand = normAddress(chain, candidate);
  if (!cand) return [];
  const found = new Map<string, LookalikeHit>();
  for (const k of known) {
    const addr = normAddress(chain, k.address);
    if (!addr || addr === cand) continue;
    if (/^0x/i.test(addr) !== /^0x/i.test(cand)) continue;
    const { prefix, suffix } = commonAffix(cand, addr);
    if (!(prefix >= prefixMin && suffix >= suffixMin && prefix + suffix >= p.total_min)) continue;
    if (!found.has(addr)) found.set(addr, { address: cand, imitates: addr, prefix, suffix, source: k.source });
  }
  return [...found.values()].sort((x, y) => {
    if (x.prefix + x.suffix !== y.prefix + y.suffix) return y.prefix + y.suffix - (x.prefix + x.suffix);
    return x.imitates < y.imitates ? -1 : x.imitates > y.imitates ? 1 : 0;
  });
}

// ── token labels: the skeleton ───────────────────────────────────────────────

const CONFUSABLES: ReadonlyMap<string, string> = new Map(SCAN_CONFUSABLES);

/** Code points that NFKC rewrites into a different letter, so they are mapped first (Greek lunate sigma). Generated with the table. */
const PRE_NFKC: ReadonlyMap<string, string> = new Map(SCAN_PRE_NFKC);

const IGNORABLES = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Mn}]/gu;

function mapChars(s: string, table: ReadonlyMap<string, string>): string {
  let out = "";
  for (const ch of s) out += table.get(ch) ?? ch;
  return out;
}

/** NFKC, strip what a person cannot see, fold look-alike letters to ASCII, uppercase. */
export function skeleton(s: string): string {
  const pre = mapChars(s, PRE_NFKC).normalize("NFKC");
  const stripped = pre.normalize("NFKD").replace(IGNORABLES, "");
  return mapChars(stripped, CONFUSABLES).toUpperCase();
}

const FAMILY_FORMS: readonly { family: string; forms: RegExp }[] = SCAN_FAMILY_FORMS.map(([family, source]) => ({ family, forms: new RegExp(source) }));

function familyOfText(text: string | null | undefined): string | null {
  if (!text) return null;
  // "USD Coin (Bridged)" is read as "USD Coin"; the bracket is a qualifier.
  for (const head of [text, text.split("(")[0] ?? text]) {
    const alnum = skeleton(head).replace(/[^A-Z0-9]/g, "");
    if (!alnum) continue;
    for (const { family, forms } of FAMILY_FORMS) if (forms.test(alnum)) return family;
  }
  return null;
}

/** The stablecoin family a symbol (else a name) imitates, or null. A claim about a label, never about a contract. */
export function claimsFamily(symbol?: string | null, name?: string | null): string | null {
  return familyOfText(symbol) ?? familyOfText(name);
}

// ── token addresses: the table ───────────────────────────────────────────────

export type CanonicalToken = { chain: string; address: string; family: string; symbol: string; kind: ScanTableKind };

const BY_CHAIN: ReadonlyMap<string, readonly CanonicalToken[]> = (() => {
  const m = new Map<string, CanonicalToken[]>();
  for (const [chain, address, family, symbol, kind] of SCAN_STABLES) {
    const k = chainKey(chain);
    const list = m.get(k) ?? [];
    list.push({ chain, address, family, symbol, kind });
    m.set(k, list);
  }
  return m;
})();

/** Does the table cover this chain at all? A stablecoin label on a chain it does not cover is not checkable here. */
export function tableCoversChain(chain: string): boolean {
  return BY_CHAIN.has(chainKey(chain));
}

/** The table entry for this contract or mint on this chain, or null. By ADDRESS; the symbol is only a label. */
export function canonicalToken(chain: string, address: string): CanonicalToken | null {
  const list = BY_CHAIN.get(chainKey(chain));
  if (!list) return null;
  const a = normAddress(chain, address);
  return list.find((t) => t.address === a) ?? null;
}

function tokenOf(t: string | ScanToken | null | undefined): ScanToken | null {
  if (t === null || t === undefined) return null;
  if (typeof t === "string") return t.trim() ? { address: t } : null;
  return t.address?.trim() ? t : null;
}

function claimedFamily(t: ScanToken): string | null {
  const f = t.family?.trim();
  if (f) {
    const known = FAMILY_FORMS.find((x) => x.family.toLowerCase() === f.toLowerCase());
    return known ? known.family : f;
  }
  return claimsFamily(t.symbol, t.name);
}

// ── scanRecipient ────────────────────────────────────────────────────────────

const LOOKALIKE_LIMIT = "a different address agreeing with a known one on the first 3 or more and the last 3 or more characters, 7 or more together";

function short(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

function lookalikeFinding(hit: LookalikeHit, chain: string, severity: "no" | "caution"): ScanFinding {
  const b = body(hit.address);
  const matchedPrefix = b.slice(0, hit.prefix);
  const matchedSuffix = b.slice(b.length - hit.suffix);
  const where = hit.source === "book" ? "an address in the book" : "an allowed recipient";
  return {
    rule: RULE_LOOKALIKE,
    verdict: severity,
    reason:
      `${short(hit.address)} is not ${short(hit.imitates)}, ${where}, but shares its first ${hit.prefix} and last ${hit.suffix} characters, ` +
      `the part a wallet shows when it abbreviates an address. ` +
      `This checked the addresses passed in; it does not say who controls either address.`,
    limit: LOOKALIKE_LIMIT,
    observed: {
      address: hit.address,
      imitates: hit.imitates,
      imitated_source: hit.source,
      matched_prefix: matchedPrefix,
      matched_suffix: matchedSuffix,
      prefix_chars: hit.prefix,
      suffix_chars: hit.suffix,
    },
  };
}

/** The recipient is in the book, but it imitates another entry recorded before it. Always a caution: both are addresses the caller listed. */
function inBookFinding(hit: LookalikeHit): ScanFinding {
  const b = body(hit.address);
  const where = hit.source === "book" ? "an earlier address in the book" : "an allowed recipient";
  return {
    rule: RULE_LOOKALIKE_IN_BOOK,
    verdict: "caution",
    reason:
      `${short(hit.address)} is in the book, but it is not ${short(hit.imitates)}, ${where}, and shares its first ${hit.prefix} and last ${hit.suffix} characters, ` +
      `the part a wallet shows when it abbreviates an address. If one of the two was added by copying from a transaction history, check which one is meant. ` +
      `This checked the addresses passed in; it does not say who controls either address.`,
    limit: LOOKALIKE_LIMIT,
    observed: {
      address: hit.address,
      imitates: hit.imitates,
      imitated_source: hit.source,
      matched_prefix: b.slice(0, hit.prefix),
      matched_suffix: b.slice(b.length - hit.suffix),
      prefix_chars: hit.prefix,
      suffix_chars: hit.suffix,
    },
  };
}

function tokenFinding(chain: string, token: ScanToken, family: string, canonical: CanonicalToken | null): ScanFinding {
  const label = token.symbol ?? token.name ?? family;
  const base = canonical
    ? `${short(token.address)} is the table's ${canonical.family} contract on ${chain}, but the payment describes it as ${family}.`
    : `${short(token.address)} on ${chain} is not a ${family} contract in the issuer table, but it is labelled as ${family} ("${label}").`;
  return {
    rule: RULE_TOKEN,
    verdict: "no",
    reason: `${base} The contract address decides; the symbol is only a label. The table is dated ${SCAN_TABLE_AS_OF}.`,
    limit: `the token's contract address must be the listed ${family} contract for the chain`,
    observed: {
      chain,
      token: normAddress(chain, token.address),
      claimed_family: family,
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      canonical_family: canonical?.family ?? null,
      table_as_of: SCAN_TABLE_AS_OF,
    },
  };
}

/**
 * Read a payment's recipient and token before anything is signed. Offline and pure.
 *
 * - The token is checked by ADDRESS against the table shipped in this package. A token that is not
 *   the listed contract but is described as a stablecoin family is refused (`token.not_canonical`).
 * - The recipient is compared with `book` and `allowRecipients` (`recipient.lookalike`).
 * - In treasury mode the recipient must be in `allowRecipients` (`recipient.not_allowlisted`).
 *   A new address that imitates nothing is not refused there for looking odd; it is refused only
 *   because it is not on the list.
 * - `go` means the recipient is an address you already know and the token check found nothing.
 *   A new address that imitates nothing is `unknown`: this pre-flight holds no record of it.
 */
export function scanRecipient(input: ScanRecipientInput): ScanRecipientResult {
  const resolved = resolveScanPolicy(input.policy);
  const policy = resolved.policy;
  const chain = input.chain;
  const vm = vmOf(chain);
  const to = normAddress(chain, input.to);
  const notes: string[] = [...resolved.notes, ...resolveDetectorParams(input.params).notes];
  const findings: ScanFinding[] = [];
  const done = (verdict: ScanVerdict, rule: string, reason: string, observed: Record<string, unknown> = {}, limit = ""): ScanRecipientResult => ({
    verdict,
    rule,
    reason,
    observed,
    limit,
    findings,
    notes,
    table_as_of: SCAN_TABLE_AS_OF,
  });

  const wellFormed = vm === "evm" ? EVM_ADDRESS.test(to) : vm === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to) : to.length > 0;
  if (!wellFormed) {
    return done(
      "unknown",
      RULE_MALFORMED,
      `"${short(String(input.to ?? ""))}" is not a well-formed ${vm === "solana" ? "Solana" : vm === "evm" ? "EVM" : chain} address, so nothing was compared.`,
      { to: String(input.to ?? ""), chain },
      "an EVM address is 0x plus 40 hex characters; a Solana address is 32 to 44 base58 characters",
    );
  }

  const bookList = forChain(chain, input.book);
  const allowList = forChain(chain, input.allowRecipients);
  const known: { address: string; source: LookalikeHit["source"] }[] = [
    ...bookList.addresses.map((address) => ({ address, source: "book" as const })),
    ...allowList.addresses.map((address) => ({ address, source: "allowRecipients" as const })),
  ];
  const skipped = bookList.skipped + allowList.skipped;
  if (skipped > 0) notes.push(`${skipped} entr${skipped === 1 ? "y" : "ies"} in the book or allow list belong to another chain and ${skipped === 1 ? "was" : "were"} ignored.`);
  const knownSet = new Set(known.map((k) => normAddress(chain, k.address)));
  const allowSet = new Set(allowList.addresses.map((a) => normAddress(chain, a)));
  const isKnown = knownSet.has(to);

  // 1. token, by address
  const token = tokenOf(input.token);
  let tokenChecked = false;
  if (token && policy.token === "refuse_not_canonical") {
    const canonical = canonicalToken(chain, token.address);
    const family = claimedFamily(token);
    if (family) {
      if (!tableCoversChain(chain)) {
        notes.push(`The token is labelled ${family}, but the stablecoin table has no entry for ${chain}, so the contract was not checked.`);
      } else {
        tokenChecked = true;
        if (!canonical || canonical.family.toLowerCase() !== family.toLowerCase()) {
          findings.push(tokenFinding(chain, token, family, canonical));
        }
      }
    } else {
      tokenChecked = true;
      notes.push(
        canonical
          ? `The token is the table's ${canonical.family} contract on ${chain}.`
          : "The token makes no stablecoin claim and is not in the table; a payment in it was not compared with anything.",
      );
    }
  } else if (token) {
    notes.push("The token check is off in the policy; the token was not compared with the table.");
  } else {
    notes.push("No token given; a native-coin payment has no token contract to compare.");
  }

  // 2. look-alike against what the agent knows
  if (policy.lookalike !== "off") {
    if (vm === "lightning") {
      notes.push("Lightning has no address form to compare; the look-alike check was not run.");
    } else if (isKnown) {
      // Recorded order: allowRecipients first, then the book, each in the caller's order (oldest first).
      const ordered: { address: string; source: LookalikeHit["source"] }[] = [
        ...allowList.addresses.map((address) => ({ address, source: "allowRecipients" as const })),
        ...bookList.addresses.map((address) => ({ address, source: "book" as const })),
      ];
      const at = ordered.findIndex((k) => normAddress(chain, k.address) === to);
      const earlier = ordered.slice(0, at < 0 ? 0 : at);
      const hits = lookalikes(chain, to, earlier, input.params);
      for (const hit of hits) findings.push(inBookFinding(hit));
      notes.push(
        hits.length === 0
          ? "The recipient is exactly an address you already know and imitates no address recorded before it."
          : "The recipient is exactly an address you already know, but it imitates one recorded before it.",
      );
    } else if (known.length === 0) {
      notes.push("The book and the allow list are empty, so there was nothing to compare the recipient with.");
    } else {
      const hits = lookalikes(chain, to, known, input.params);
      const severity = policy.lookalike === "caution" ? "caution" : "no";
      for (const hit of hits) findings.push(lookalikeFinding(hit, chain, severity));
      if (hits.length === 0) notes.push(`The recipient was compared with ${knownSet.size} known address${knownSet.size === 1 ? "" : "es"} and resembles none.`);
    }
  } else {
    notes.push("The look-alike check is off in the policy.");
  }

  // 3. treasury mode
  if (input.treasury === true && policy.treasury_recipients !== "off") {
    if (!allowSet.has(to)) {
      findings.push({
        rule: RULE_NOT_ALLOWLISTED,
        verdict: "no",
        reason:
          `${short(to)} is not in the allowed recipients. In treasury mode only listed addresses are paid. ` +
          `This is the policy's own rule; it says nothing about the address.`,
        limit: "in treasury mode the recipient must be one of allow_recipients",
        observed: { to, allow_recipients: allowSet.size },
      });
    }
  }

  // refusals first, then cautions, in the order they fired
  const ordered = [...findings.filter((f) => f.verdict === "no"), ...findings.filter((f) => f.verdict === "caution")];
  findings.length = 0;
  findings.push(...ordered);
  const top = findings[0];
  if (top) return done(top.verdict, top.rule, top.reason, top.observed, top.limit);

  if (isKnown && (tokenChecked || !token)) {
    return done(
      "go",
      "scan.go",
      `${short(to)} is an address you already know${token && tokenChecked ? " and the token check found nothing" : ""}. ` +
        `This is a local pre-flight: it did not look up either address onchain.`,
    );
  }
  if (isKnown) {
    return done("go", "scan.go", `${short(to)} is an address you already know. This is a local pre-flight: it did not look up either address onchain.`);
  }
  notes.push("This is a new address that imitates nothing you passed in. This pre-flight holds no record of it; that is not a finding for or against it.");
  return done(
    "unknown",
    "scan.unknown",
    `${short(to)} is not an address you already know and imitates none of them. This pre-flight holds no record of it. ` +
      `Ask the hosted check (checkRecipientHosted) for more, or pay it only if you already trust where it came from.`,
  );
}

// ── sanitizeTransfers ────────────────────────────────────────────────────────

/** A transfer row from an indexer or explorer. Field names vary; pass `read` for a shape this does not know. */
export type TransferRow = Record<string, unknown>;

export type TransferTokenRead = { address?: string | null; symbol?: string | null; name?: string | null };

export type SanitizeOptions<T> = {
  chain: string;
  /** Pull the token address, symbol and name out of a row. The default reads the common field names. */
  read?: (row: T) => TransferTokenRead;
};

export type SanitizeResult<T> = {
  /** The rows to keep, in their original order. */
  rows: T[];
  /** The rows that were dropped. */
  removed: T[];
  /** Rows kept because they could not be checked: a stablecoin label with no readable token address, or on a chain the table does not cover. */
  unchecked: T[];
  /** One line per stablecoin family a dropped row imitated, plus one for the rows that could not be checked. */
  notes: string[];
};

/** Field names that hold a token contract or mint in indexer output. Any string there is read as the address. */
const ADDRESS_KEYS = ["token_address", "tokenAddress", "contractAddress", "contract_address", "mint"] as const;
/**
 * Field names that are often something else (a symbol, a nested object). Read only when the value is address-shaped for the chain.
 * A row's bare `address` is never read: in indexer output it is usually the holder or counterparty wallet, and reading it as the token
 * contract would compare the wrong address with the table.
 */
const LOOSE_ADDRESS_KEYS = ["contract", "token"] as const;
const SYMBOL_KEYS = ["symbol", "tokenSymbol", "token_symbol"] as const;
const NAME_KEYS = ["name", "tokenName", "token_name"] as const;

function firstString(row: TransferRow, keys: readonly string[], accept: (v: string) => boolean = () => true): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim() && accept(v.trim())) return v.trim();
  }
  return null;
}

/** Is this string the address form of the chain (0x + 40 hex on EVM, 32 to 44 base58 on Solana)? Lightning has none. */
function addressShaped(chain: string, v: string): boolean {
  const vm = vmOf(chain);
  if (vm === "evm") return EVM_ADDRESS.test(v);
  if (vm === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  return false;
}

function readDefault(row: TransferRow, chain: string): TransferTokenRead {
  const shaped = (v: string) => addressShaped(chain, v);
  return {
    address: firstString(row, ADDRESS_KEYS, shaped) ?? firstString(row, LOOSE_ADDRESS_KEYS, shaped),
    symbol: firstString(row, SYMBOL_KEYS),
    name: firstString(row, NAME_KEYS),
  };
}

/**
 * Drop the rows whose token address is not the canonical contract but whose symbol or name claims
 * a stablecoin family. The claim is read from the skeleton of the label, so a Georgian or Lisu
 * letter, a Khmer vowel or a zero-width character does not hide it. A row with no stablecoin
 * label (a native coin, an ordinary token) is kept; so is a row whose address is the listed contract.
 *
 * A row that carries a stablecoin label but no readable token address (none of the token fields
 * holds an address-shaped value for the chain) cannot be checked. It is kept, returned in
 * `unchecked`, and counted in `notes`, so a caller can drop it or look at it. Kept does not mean
 * checked.
 */
export function sanitizeTransfers<T extends object>(list: readonly T[], opts: SanitizeOptions<T>): SanitizeResult<T> {
  const read = opts.read ?? ((row: T) => readDefault(row as TransferRow, opts.chain));
  const rows: T[] = [];
  const removed: T[] = [];
  const unchecked: T[] = [];
  const byFamily = new Map<string, number>();
  let noAddress = 0;
  let uncovered = 0;
  const covered = tableCoversChain(opts.chain);
  for (const row of list) {
    const { address, symbol, name } = read(row);
    const family = claimsFamily(symbol, name);
    if (!family) {
      rows.push(row);
      continue;
    }
    const addr = typeof address === "string" ? address.trim() : "";
    if (!addr || !addressShaped(opts.chain, addr)) {
      noAddress++;
      unchecked.push(row);
      rows.push(row);
      continue;
    }
    if (!covered) {
      uncovered++;
      unchecked.push(row);
      rows.push(row);
      continue;
    }
    const canonical = canonicalToken(opts.chain, addr);
    if (canonical && canonical.family.toLowerCase() === family.toLowerCase()) {
      rows.push(row);
      continue;
    }
    removed.push(row);
    byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
  }
  const notes: string[] = [];
  for (const [family, n] of byFamily) notes.push(`${n} row${n === 1 ? "" : "s"} removed: token${n === 1 ? "" : "s"} imitating ${family}`);
  if (noAddress > 0) {
    notes.push(`${noAddress} row${noAddress === 1 ? "" : "s"} carry a stablecoin label but no readable token address; kept, not checked`);
  }
  if (uncovered > 0) {
    notes.push(`${uncovered} row${uncovered === 1 ? "" : "s"} carry a stablecoin label on ${opts.chain}, which the table does not cover; kept, not checked`);
  }
  return { rows, removed, unchecked, notes };
}

// ── checkRecipientHosted ─────────────────────────────────────────────────────

/** Optional fields a caller may choose to send to the hosted check. Sent only when named in `include`. */
export type RecipientIncludeField = "from" | "origin" | "amount";

export type RecipientHostedInput = {
  chain: string;
  to: string;
  token?: string | null;
  /** Base units, decimal string. */
  amount?: string | null;
  /** The paying wallet; enables the checks that need history. */
  from?: string | null;
  /** The URL whose 402 response named `to`. */
  origin?: string | null;
};

/** The shape of the signed reading. Additive; the app's schema is authoritative. */
export type RecipientReading = {
  schema: "sato.scan.recipient/v1";
  verdict: ScanVerdict;
  rule: string;
  reason: string;
  limits?: { notes?: string[] } & Record<string, unknown>;
  as_of?: string;
} & Record<string, unknown>;

export type RecipientHostedOptions = SatoHubClientOptions & {
  /** Use an existing client (its baseUrl, fetch, verify mode and user agent). */
  client?: { checkRecipient(input: RecipientHostedInput, opts?: { include?: readonly RecipientIncludeField[] }): Promise<SatoResponse<RecipientReading>> };
  /**
   * Extra fields to send beyond the documented `chain`, `to` and `token`: any of "from" (the paying
   * wallet, enables checks that need history), "origin" (the URL whose 402 named `to`) and
   * "amount". Nothing else is ever sent, and none of these is sent unless it is named here.
   */
  include?: readonly RecipientIncludeField[];
  /** Extra attempts after a network error or a 5xx. Never after a 4xx. Default 1. */
  retries?: number;
};

export type RecipientHostedResult = {
  verdict: ScanVerdict;
  rule: string;
  reason: string;
  /** The signed reading when the call succeeded; null when it failed. */
  reading: RecipientReading | null;
  signature: SignatureCheck | null;
  /** Set when the call failed. A failure is "unknown", not a finding about the recipient. */
  error?: string;
  /** HTTP status when the failure was an HTTP answer. */
  status?: number;
};

function recipientInput(input: RecipientHostedInput, include: readonly RecipientIncludeField[]): RecipientHostedInput {
  const out: RecipientHostedInput = { chain: input.chain, to: input.to };
  if (input.token !== undefined && input.token !== null && input.token !== "") out.token = input.token;
  for (const k of include) if (input[k] !== undefined && input[k] !== null && input[k] !== "") out[k] = input[k];
  return out;
}

/**
 * Ask Sato Hub for the full recipient reading. Opt-in: nothing calls this unless you do. It sends
 * `chain`, `to` and `token` only; `from`, `origin` and `amount` are sent only if you name them in
 * `opts.include`. Fails open: any failure comes back as verdict "unknown" with the
 * error, so it never blocks a payment by itself and never reads as a clearance. A 4xx is a bad
 * request or a rate limit and is not retried; a network error or a 5xx is retried `retries` times.
 */
export async function checkRecipientHosted(input: RecipientHostedInput, opts: RecipientHostedOptions = {}): Promise<RecipientHostedResult> {
  const unknown = (error: string, status?: number): RecipientHostedResult => ({
    verdict: "unknown",
    rule: "hosted.unavailable",
    reason: `The hosted check could not be read (${error}). That is not a finding about the recipient.`,
    reading: null,
    signature: null,
    error,
    ...(status !== undefined ? { status } : {}),
  });
  if (!input?.chain?.trim() || !input?.to?.trim()) return unknown("chain and to are required");
  const { client: given, retries, include: includeGiven, ...clientOpts } = opts;
  const include = (Array.isArray(includeGiven) ? includeGiven : []).filter((k): k is RecipientIncludeField => k === "from" || k === "origin" || k === "amount");
  // Pre-filtered here too, so a custom client only ever sees the fields the caller opted in to.
  const sent = recipientInput(input, include);
  let client: NonNullable<RecipientHostedOptions["client"]>;
  try {
    client = given ?? new SatoHubClient(clientOpts);
  } catch (e) {
    return unknown(e instanceof Error ? e.message : String(e));
  }
  const attempts = 1 + Math.max(0, retries ?? 1);
  let last: RecipientHostedResult = unknown("no attempt was made");
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await client.checkRecipient(sent, { include });
      const reading = res.data;
      if (!reading || typeof reading !== "object" || typeof reading.verdict !== "string") return unknown("the response was not a recipient reading");
      return { verdict: reading.verdict, rule: String(reading.rule ?? ""), reason: String(reading.reason ?? ""), reading, signature: res.signature };
    } catch (e) {
      if (e instanceof SatoHttpError) {
        last = unknown(`HTTP ${e.status}`, e.status);
        if (e.status >= 400 && e.status < 500) return last;
      } else {
        last = unknown(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return last;
}
