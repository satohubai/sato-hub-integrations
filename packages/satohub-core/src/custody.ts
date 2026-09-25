// Mirrored from the Sato Hub app's lib/custody/types.ts (schema sato.custody/v1).
// The package cannot import the app, so the contract is copied. Additive changes only.

export const CUSTODY_SCHEMA = "sato.custody/v1" as const;
/** Bump when a lane's rules change so stored profiles say which rules produced them. */
export const CUSTODY_METHOD_VERSION = "custody-1" as const;

export type CustodySubjectKind = "package" | "mcp" | "skill" | "repo" | "x402";

export type CustodySubject = {
  kind: CustodySubjectKind;
  /**
   * Canonical id, stable across versions:
   *   package → "npm:<name>" | "pypi:<name>"
   *   mcp     → the endpoint URL (remote) or "npm:<name>" style id of its package (stdio) prefixed "mcp:"
   *   skill   → the skills table id (e.g. "clawhub:<owner>/<slug>", "skills.sh:<owner>/<repo>/<skill>")
   *   repo    → "github:<owner>/<repo>"
   *   x402    → the resource URL, normalised (lowercase host, no trailing slash, no query)
   */
  id: string;
  /** Human name for display. */
  name: string;
  /** The version profiled, when the artifact has one. */
  version: string | null;
  /** sha256 of the exact artifact profiled (tarball, skill bundle, tools/list JSON, 402 body). */
  digest: string | null;
  /** The Sato Hub listing this subject belongs to, when known. */
  listing_slug?: string | null;
};

export type EvidenceClass = "declared" | "traced" | "observed";

export type CustodyQuestion =
  | "key_access"
  | "key_egress"
  | "fund_actions"
  | "changes"
  | "hosts"
  | "install_scripts";

export type CustodyEvidence = {
  class: EvidenceClass;
  question: CustodyQuestion;
  /** Rule id, prefix by class: "D-…" declared, "T-…" traced, "O-…" observed. See CUSTODY_RULES. */
  rule: string;
  /** One sentence. Describes what was read; never judges. */
  detail: string;
  /** file:line inside the artifact, a URL, or "sandbox:<run_id>". */
  source: string;
  /** ISO timestamp of the reading. */
  as_of: string;
};

/**
 * none_found — we looked (declared + traced ran) and found no key read
 * declared   — the project asks for a private key / seed / keystore
 * reads      — code or a sandbox run reads key material
 * unknown    — we could not look (no artifact, lane did not run)
 */
export type KeyAccess = "none_found" | "declared" | "reads" | "unknown";

/**
 * observed     — a planted test key was sent off the machine (host in key_egress_hosts)
 * not_observed — the observed lane ran and saw no planted key leave (limits apply)
 * unknown      — the observed lane has not run on this version
 */
export type KeyEgress = "not_observed" | "observed" | "unknown";

export type FundActionKind =
  | "transfer"
  | "swap"
  | "bridge"
  | "approve"
  | "withdraw"
  | "deploy"
  | "mint"
  | "sign"
  | "trade"
  | "other";

export type FundAction = {
  /** Tool or function name as the subject exposes it. */
  name: string;
  action: FundActionKind;
  /** true = a spend/amount limit can be configured; false = none found; null = could not tell. */
  limit_configurable: boolean | null;
  evidence_class: EvidenceClass;
};

/** vendor = the project's own service; rpc = a chain node; registry = npm/pypi/github; other = anything else. */
export type HostRole = "vendor" | "rpc" | "registry" | "other";

export type HostContact = {
  host: string;
  /** code = a literal in shipped code (traced); install/start/call = seen in a sandbox run (observed). */
  phase: "code" | "install" | "start" | "call";
  role: HostRole;
  evidence_class: EvidenceClass;
};

export type CustodyChangeKind =
  | "host_added"
  | "host_removed"
  | "key_read_added"
  | "key_read_removed"
  | "fund_action_added"
  | "fund_action_removed"
  | "install_script_added"
  | "install_script_changed"
  | "egress_observed"
  | "egress_cleared";

export type CustodyChange = { kind: CustodyChangeKind; detail: string };

export type LaneStatus = {
  ran: boolean;
  as_of: string | null;
  /** Why it did not run, or what it could not cover. */
  note?: string;
};

export type CustodyProfile = {
  schema: typeof CUSTODY_SCHEMA;
  subject: CustodySubject;
  key_access: KeyAccess;
  key_egress: KeyEgress;
  /** Hosts a planted key was sent to. Empty unless key_egress is "observed". */
  key_egress_hosts: string[];
  fund_actions: FundAction[] | "none_found" | "unknown";
  hosts: HostContact[];
  /** npm pre/postinstall (or equivalent). null = could not tell. */
  install_scripts: { present: boolean; commands: string[] } | null;
  /** Diff vs the previous profiled version of the same subject id. null = no earlier profile. */
  changes: { from_version: string | null; items: CustodyChange[] } | null;
  /** Rule ids from NOTABLE_RULES that fired. Empty = nothing notable. */
  notable: string[];
  lanes: { declared: LaneStatus; traced: LaneStatus; observed: LaneStatus };
  /** Plain-language limits of what was checked — always rendered. */
  limits: string[];
  evidence: CustodyEvidence[];
  as_of: string;
  method_version: string;
};

/** The compact form carried on listings (overlay field `custody`), exports, picks and Preflight. */
export type CustodySummary = {
  key_access: KeyAccess;
  key_egress: KeyEgress;
  /** null when fund_actions is "unknown". */
  fund_action_count: number | null;
  notable: boolean;
  version: string | null;
  as_of: string;
  method_version: string;
  /** Canonical /check URL for the full profile. */
  check_url: string;
};

/**
 * A sandbox run (observed lane). Produced by scripts/custody-observe, stored,
 * then merged into the profile by the assembler.
 */
export type ObservedRun = {
  run_id: string;
  subject: CustodySubject;
  as_of: string;
  /** Which planted token families were present (e.g. "evm_private_key", "solana_keypair", "bip39_mnemonic"). */
  canaries: string[];
  /** Every host contacted, by phase. */
  hosts: { host: string; phase: "install" | "start" | "call" }[];
  /** A planted canary seen leaving. `encoding` = raw | hex | base64 | base58. Secret is never stored. */
  egress_hits: { host: string; phase: "install" | "start" | "call"; canary: string; encoding: string; request_line: string }[];
  install_scripts_ran: boolean | null;
  /** What the run could not cover (e.g. "stdio server did not answer initialize"). */
  notes: string[];
  ok: boolean;
};

// ── API contract (implemented by app/api/check/**) ─────────────────────────
//
//   GET  /api/check?target=<string>[&kind=<CustodySubjectKind>]
//        → CheckResponse (signed like /api/preflight). ≤10 s; declared+traced
//          run live for an unstored subject, observed is read from storage only.
//   POST /api/check/install  body { command?: string; config?: string }
//        → InstallCheckResponse. Parses npm/pnpm/yarn/bun add|install, npx -y,
//          pip install, uvx, `claude mcp add …`, and MCP JSON config blocks.
//
// MCP tool `onchain_agent_check_install` returns InstallCheckResponse;
// `onchain_agent_preflight` carries `custody: CustodySummary` where one exists.

export type CheckResponse = {
  schema: typeof CUSTODY_SCHEMA;
  profile: CustodyProfile;
  summary: CustodySummary;
  /** The four answers as plain sentences, from lib/custody/wording.ts. */
  answers: { key_access: string; key_egress: string; fund_actions: string; changes: string };
  check_url: string;
};

export type InstallCheckResponse = {
  schema: typeof CUSTODY_SCHEMA;
  subjects: {
    subject: CustodySubject;
    summary: CustodySummary;
    answers: CheckResponse["answers"];
  }[];
  /** Tokens we recognised as install targets but could not profile, with the reason. */
  unresolved: { input: string; reason: string }[];
  /** True only when some subject has key_egress "observed" — the one blocking fact. */
  has_observed_key_egress: boolean;
};
