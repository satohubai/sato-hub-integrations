// Vendored verbatim into @satohub/kit (packages/kit/src/spec). Edit here, then re-vendor.
/**
 * `sato.policy/v1` — the policy.json a generated repo carries and the kit's
 * pre-flight reads. FILE FORMAT, DEFAULTS, RULE IDS AND THE REFUSAL SHAPE ONLY.
 * The evaluator is the kit's (packages/kit); this file decides nothing about a
 * live intent.
 *
 * WHAT THIS FILE IS HONEST ABOUT: the kit's pre-flight runs in the agent's own
 * process. It EXPLAINS refusals; it does not enforce them. Enforcement lives in
 * the signer (CDP, Privy, Turnkey, OWS, a Safe allowance module), which the
 * kit compiles this same file into where the signer supports it. Nothing here
 * may be described as a guarantee.
 *
 * SEMANTICS, carried over from Sato Swap's swapPolicySchema (lib/swap/policy.ts):
 *   - STRICT ON UNKNOWN, PERMISSIVE ON EMPTY. An empty allowlist means "any,
 *     subject to the other rules" — an operator who listed no venues has not
 *     thereby refused every venue. `unknown_verdict` defaults to "refuse": a
 *     reading we cannot make (no price, no record) does not pass by default.
 *   - EVERY REFUSAL NAMES ITS RULE AND THE TWO VALUES IT COMPARED. `limit` and
 *     `observed` are strings and are never absent; an unreadable value is the
 *     string "unknown".
 *   - VENUE NEUTRALITY. `allow_venues` empty = any venue or aggregator. Nothing
 *     in the format ranks, penalises or prefers a venue (scope §0.3).
 *   - `require_simulation` is a CONSTANT `true`, not a setting: tx_simulate
 *     runs before any signature (scope §0.1). A file that sets it false is
 *     malformed.
 *   - `human_approval` defaults to FALSE in the file format, which is right for
 *     a plain-ts developer template on a fork. Scope §0.1: consumer-facing
 *     agents default to human approval — a template for a consumer-facing
 *     agent MUST write `"human_approval": true` into its policy_defaults.
 *   - Amounts in `max_per_trade` are BASE UNITS as decimal strings. A USD cap
 *     only bites when a price is known; with no price the reading is unknown
 *     and `unknown_verdict` decides — never a silent zero.
 *
 * Pure and dependency-free.
 */

export const POLICY_SCHEMA_ID = "sato.policy/v1" as const;

export const POLICY_NETWORKS = ["fork", "testnet", "mainnet"] as const;
export type PolicyNetwork = (typeof POLICY_NETWORKS)[number];

/** Stable rule ids. A refusal carries exactly one. Additive only; never renamed. */
export const POLICY_RULES = [
  { id: "chain_allowlist", meaning: "The intent's chain is not in allow_chains." },
  { id: "token_allowlist", meaning: "A token the intent touches is not in allow_tokens." },
  { id: "contract_allowlist", meaning: "The contract the transaction calls is not in allow_contracts." },
  { id: "recipient_allowlist", meaning: "The recipient of funds is not in allow_recipients." },
  { id: "venue_allowlist", meaning: "The quote's venue is not in allow_venues." },
  { id: "max_usd_per_trade", meaning: "The trade's USD notional is over max_usd_per_trade." },
  { id: "max_usd_per_day", meaning: "The day's USD total including this trade is over max_usd_per_day." },
  { id: "max_per_trade", meaning: "The trade's base-unit amount of a token is over its max_per_trade entry." },
  { id: "max_slippage_bps", meaning: "The requested slippage tolerance is over max_slippage_bps." },
  { id: "intent_ttl", meaning: "The intent expired before execute, or asked for a TTL over intent_ttl_s." },
  { id: "unknown_price", meaning: "A USD cap is set and no price was available to read the notional." },
  { id: "unknown_verdict", meaning: "A reading the policy needs could not be made and unknown_verdict is refuse." },
  { id: "simulation_required", meaning: "No simulation result is attached to the intent." },
  { id: "simulation_failed", meaning: "The simulation of the unsigned transaction reverted or errored." },
  { id: "network_mainnet_not_enabled", meaning: "The intent targets mainnet and the policy's network is not mainnet." },
] as const;

export type PolicyRuleId = (typeof POLICY_RULES)[number]["id"];
export const POLICY_RULE_IDS: readonly PolicyRuleId[] = POLICY_RULES.map((r) => r.id);

export function isPolicyRuleId(v: unknown): v is PolicyRuleId {
  return typeof v === "string" && (POLICY_RULE_IDS as readonly string[]).includes(v);
}

/**
 * One refusal. `limit` and `observed` are always strings; "unknown" when the
 * value could not be read. `message` is one plain sentence naming both.
 */
export type Refusal = {
  rule: PolicyRuleId;
  limit: string;
  observed: string;
  message: string;
};

export type SatoPolicy = {
  schema: typeof POLICY_SCHEMA_ID;
  version: 1;
  network: PolicyNetwork;
  /** Chain names (the ODA chain enum). Empty = any. */
  allow_chains: string[];
  /** "<chain>:<address or SYMBOL>". Empty = any. */
  allow_tokens: string[];
  /** "<chain>:<address>". Empty = any. */
  allow_contracts: string[];
  /** "<chain>:<address>". Empty = any. */
  allow_recipients: string[];
  /** Venue or aggregator names. EMPTY = ANY VENUE (venue neutrality). */
  allow_venues: string[];
  max_usd_per_trade: number | null;
  max_usd_per_day: number | null;
  /** { "<chain>:<token>": "<base units, decimal string>" } */
  max_per_trade: Record<string, string>;
  max_slippage_bps: number | null;
  intent_ttl_s: number;
  unknown_verdict: "refuse" | "allow";
  require_simulation: true;
  human_approval: boolean;
};

export const INTENT_TTL_DEFAULT_S = 300;
export const INTENT_TTL_MAX_S = 3600;
export const MAX_SLIPPAGE_BPS_CEILING = 5000;

export const POLICY_DEFAULTS: Omit<SatoPolicy, "schema" | "version"> = {
  network: "fork",
  allow_chains: [],
  allow_tokens: [],
  allow_contracts: [],
  allow_recipients: [],
  allow_venues: [],
  max_usd_per_trade: null,
  max_usd_per_day: null,
  max_per_trade: {},
  max_slippage_bps: null,
  intent_ttl_s: INTENT_TTL_DEFAULT_S,
  unknown_verdict: "refuse",
  require_simulation: true,
  human_approval: false,
};

/** "<chain>:<address or symbol>" — chain as a lowercase name, the rest alphanumeric. */
export const CHAIN_QUALIFIED_RE = /^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9]{1,64}$/;
/** Base units: decimal digits only, no sign, no point, at most uint256's 78 digits. */
export const BASE_UNITS_RE = /^[0-9]{1,78}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/;

export const POLICY_KEYS = [
  "schema",
  "version",
  "network",
  "allow_chains",
  "allow_tokens",
  "allow_contracts",
  "allow_recipients",
  "allow_venues",
  "max_usd_per_trade",
  "max_usd_per_day",
  "max_per_trade",
  "max_slippage_bps",
  "intent_ttl_s",
  "unknown_verdict",
  "require_simulation",
  "human_approval",
] as const;

export type PolicyParse = { ok: true; policy: SatoPolicy } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function list(v: unknown, field: string, re: RegExp, max = 200): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return `${field} must be an array`;
  if (v.length > max) return `${field} has more than ${max} entries`;
  for (const [i, x] of v.entries()) {
    if (typeof x !== "string" || !re.test(x)) return `${field}[${i}] is not in the expected form`;
  }
  return [...new Set(v as string[])];
}

function usd(v: unknown, field: string): number | null | string {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return `${field} must be a positive number or null`;
  return v;
}

/** Parse a policy.json value. Fills every default; refuses unknown keys. */
export function parsePolicyFile(input: unknown): PolicyParse {
  if (!isObj(input)) return { ok: false, error: "policy must be a JSON object" };
  for (const k of Object.keys(input)) {
    if (!(POLICY_KEYS as readonly string[]).includes(k)) return { ok: false, error: `unknown property ${JSON.stringify(k)}` };
  }
  if (input.schema !== POLICY_SCHEMA_ID) return { ok: false, error: `schema must be ${JSON.stringify(POLICY_SCHEMA_ID)}` };
  if (input.version !== undefined && input.version !== 1) return { ok: false, error: "version must be 1" };

  const network = input.network === undefined ? POLICY_DEFAULTS.network : input.network;
  if (!(POLICY_NETWORKS as readonly unknown[]).includes(network)) return { ok: false, error: `network must be one of ${POLICY_NETWORKS.join(", ")}` };

  const chains = list(input.allow_chains, "allow_chains", NAME_RE);
  if (typeof chains === "string") return { ok: false, error: chains };
  const tokens = list(input.allow_tokens, "allow_tokens", CHAIN_QUALIFIED_RE);
  if (typeof tokens === "string") return { ok: false, error: tokens };
  const contracts = list(input.allow_contracts, "allow_contracts", CHAIN_QUALIFIED_RE);
  if (typeof contracts === "string") return { ok: false, error: contracts };
  const recipients = list(input.allow_recipients, "allow_recipients", CHAIN_QUALIFIED_RE);
  if (typeof recipients === "string") return { ok: false, error: recipients };
  const venues = list(input.allow_venues, "allow_venues", NAME_RE);
  if (typeof venues === "string") return { ok: false, error: venues };

  const perTrade = usd(input.max_usd_per_trade, "max_usd_per_trade");
  if (typeof perTrade === "string") return { ok: false, error: perTrade };
  const perDay = usd(input.max_usd_per_day, "max_usd_per_day");
  if (typeof perDay === "string") return { ok: false, error: perDay };

  const maxPer: Record<string, string> = {};
  if (input.max_per_trade !== undefined) {
    if (!isObj(input.max_per_trade)) return { ok: false, error: "max_per_trade must be an object of token → base units" };
    for (const [k, v] of Object.entries(input.max_per_trade)) {
      if (!CHAIN_QUALIFIED_RE.test(k)) return { ok: false, error: `max_per_trade key ${JSON.stringify(k)} must be "<chain>:<token>"` };
      if (typeof v !== "string" || !BASE_UNITS_RE.test(v)) return { ok: false, error: `max_per_trade[${JSON.stringify(k)}] must be base units as a decimal string` };
      maxPer[k] = v;
    }
  }

  let slip: number | null = null;
  if (input.max_slippage_bps !== undefined && input.max_slippage_bps !== null) {
    const s = input.max_slippage_bps;
    if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s > MAX_SLIPPAGE_BPS_CEILING) {
      return { ok: false, error: `max_slippage_bps must be an integer in 0..${MAX_SLIPPAGE_BPS_CEILING} or null` };
    }
    slip = s;
  }

  let ttl = INTENT_TTL_DEFAULT_S;
  if (input.intent_ttl_s !== undefined) {
    const t = input.intent_ttl_s;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > INTENT_TTL_MAX_S) {
      return { ok: false, error: `intent_ttl_s must be an integer in 1..${INTENT_TTL_MAX_S}` };
    }
    ttl = t;
  }

  const uv = input.unknown_verdict === undefined ? "refuse" : input.unknown_verdict;
  if (uv !== "refuse" && uv !== "allow") return { ok: false, error: "unknown_verdict must be 'refuse' or 'allow'" };

  if (input.require_simulation !== undefined && input.require_simulation !== true) {
    return { ok: false, error: "require_simulation is a constant true — simulation runs before every signature" };
  }
  if (input.human_approval !== undefined && typeof input.human_approval !== "boolean") {
    return { ok: false, error: "human_approval must be a boolean" };
  }

  return {
    ok: true,
    policy: {
      schema: POLICY_SCHEMA_ID,
      version: 1,
      network: network as PolicyNetwork,
      allow_chains: chains,
      allow_tokens: tokens,
      allow_contracts: contracts,
      allow_recipients: recipients,
      allow_venues: venues,
      max_usd_per_trade: perTrade,
      max_usd_per_day: perDay,
      max_per_trade: maxPer,
      max_slippage_bps: slip,
      intent_ttl_s: ttl,
      unknown_verdict: uv,
      require_simulation: true,
      human_approval: input.human_approval === true,
    },
  };
}

/** An allowlist check with the format's one semantic: empty = any. Case-insensitive. */
export function allowlistPermits(list: readonly string[], value: string): boolean {
  if (list.length === 0) return true;
  const v = value.toLowerCase();
  return list.some((x) => x.toLowerCase() === v);
}
