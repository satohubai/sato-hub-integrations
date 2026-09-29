// @satohub/kit/sato-os — the Sato OS hand-off (scope §11).
//
// In live mode an agent can send its prepared intents to a self-hosted Sato OS
// for a person's approval and for signing there, instead of signing locally.
// This module only TALKS to Sato OS: it attaches the agent (and receives its
// scoped API token), and files prepared intents as proposals. Nothing in this
// path holds a key, signs or broadcasts; a refused intent is never proposed.
//
// Wire shapes match the Sato OS routes:
//   POST <base>/api/os/agents/attach  body {name, goal, walletAddresses, chains, …, issueToken:true}
//     → 201 {ok:true, data:{agent:{id,slug,open_at}, wallets, passportImported, apiToken, mcpEndpoint}}
//     → 4xx {ok:false, error, fields?}
//   POST <base>/api/os/mcp  JSON-RPC tools/call "sato_os_create_action_proposal", Bearer <apiToken>
//     → result.structuredContent {intentId, approvalId, policy, status, tier} | {error}

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedIntent } from "../spec/index.js";
import { KIT_USER_AGENT } from "../version.js";

export const SATO_OS_CONFIG_FILE = "sato-os.json";
export const SATO_OS_PROPOSAL_TOOL = "sato_os_create_action_proposal";
const DEFAULT_TIMEOUT_MS = 15_000;

export type SatoOsFetch = typeof fetch;

export class SatoOsError extends Error {
  constructor(
    readonly code: "refused_intent" | "expired_intent" | "http" | "rpc" | "tool" | "bad_response" | "config",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SatoOsError";
  }
}

/** What .sato/sato-os.json holds. The token is a secret: the file is 0600 and gitignored. */
export type SatoOsConfig = {
  base_url: string;
  agent_id: string;
  agent_slug: string;
  mcp_endpoint: string;
  token: string;
  attached_at: string;
};

export type AttachOptions = {
  baseUrl: string;
  name: string;
  /** What the agent does (Sato OS requires 12+ characters). */
  goal: string;
  /** At least one address; Sato OS observes these wallets. */
  walletAddresses: string[];
  /** EVM chains to monitor (required by Sato OS when an EVM address is given). */
  chains: string[];
  agentType?: string;
  endpointUrl?: string;
  passportSlug?: string;
  fetch?: SatoOsFetch;
  /** Directory for the config file. Default "<cwd>/.sato". */
  dir?: string;
  /** Replace an existing sato-os.json. Default false: an existing token is never silently overwritten. */
  overwrite?: boolean;
  timeoutMs?: number;
  clock?: () => number;
};

/** The attach result. The token is persisted, never returned. */
export type AttachResult = {
  agent_id: string;
  agent_slug: string;
  open_at: string;
  mcp_endpoint: string;
  config_path: string;
};

function trimBase(u: string): string {
  const s = u.replace(/\/+$/, "");
  if (!/^https?:\/\/.+/.test(s)) throw new SatoOsError("config", "baseUrl must be an http(s) URL.");
  return s;
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json", "user-agent": KIT_USER_AGENT };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function ensureGitignored(dir: string): Promise<void> {
  const path = join(dir, ".gitignore");
  let cur = "";
  try {
    cur = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (cur.split(/\r?\n/).some((l) => l.trim() === SATO_OS_CONFIG_FILE || l.trim() === "*")) return;
  await writeFile(path, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${SATO_OS_CONFIG_FILE}\n`);
}

/** Reads .sato/sato-os.json. Throws SatoOsError("config") when absent or malformed. */
export async function readSatoOsConfig(dir = join(process.cwd(), ".sato")): Promise<SatoOsConfig> {
  let raw: string;
  try {
    raw = await readFile(join(dir, SATO_OS_CONFIG_FILE), "utf8");
  } catch {
    throw new SatoOsError("config", `No ${SATO_OS_CONFIG_FILE} in ${dir}; attach first.`);
  }
  const c = JSON.parse(raw) as Partial<SatoOsConfig>;
  for (const k of ["base_url", "agent_id", "token", "mcp_endpoint"] as const) {
    if (typeof c[k] !== "string" || !c[k]) throw new SatoOsError("config", `${SATO_OS_CONFIG_FILE} is missing ${k}.`);
  }
  return c as SatoOsConfig;
}

/**
 * Attaches this agent to a Sato OS instance, asks it to issue the agent's
 * scoped API token, and writes it to <dir>/sato-os.json (mode 0600, listed in
 * <dir>/.gitignore). The token is never returned or logged.
 */
export async function attachToSatoOs(opts: AttachOptions): Promise<AttachResult> {
  const base = trimBase(opts.baseUrl);
  const dir = opts.dir ?? join(process.cwd(), ".sato");
  const path = join(dir, SATO_OS_CONFIG_FILE);
  if (!opts.overwrite) {
    try {
      await readFile(path);
      throw new SatoOsError("config", `${path} already exists; pass overwrite: true to replace it.`);
    } catch (e) {
      if (e instanceof SatoOsError) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const f = opts.fetch ?? fetch;
  const body = {
    name: opts.name,
    goal: opts.goal,
    walletAddresses: opts.walletAddresses,
    chains: opts.chains,
    ...(opts.agentType ? { agentType: opts.agentType } : {}),
    ...(opts.endpointUrl ? { endpointUrl: opts.endpointUrl } : {}),
    ...(opts.passportSlug ? { passportSlug: opts.passportSlug } : {}),
    issueToken: true,
  };
  const res = await f(`${base}/api/os/agents/attach`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as
    | { ok: true; data: { agent?: { id?: string; slug?: string; open_at?: string }; apiToken?: string | null; mcpEndpoint?: string } }
    | { ok: false; error?: string }
    | null;
  if (!res.ok || !json || json.ok !== true) {
    const msg = json && json.ok === false && json.error ? json.error : `attach failed with HTTP ${res.status}`;
    throw new SatoOsError("http", msg, res.status);
  }
  const d = json.data;
  if (!d.agent?.id || !d.apiToken) throw new SatoOsError("bad_response", "Sato OS did not return an agent id and token.");
  const config: SatoOsConfig = {
    base_url: base,
    agent_id: d.agent.id,
    agent_slug: d.agent.slug ?? "",
    mcp_endpoint: d.mcpEndpoint ?? "/api/os/mcp",
    token: d.apiToken,
    attached_at: new Date((opts.clock ?? Date.now)()).toISOString(),
  };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
  await ensureGitignored(dir);
  return {
    agent_id: config.agent_id,
    agent_slug: config.agent_slug,
    open_at: d.agent.open_at ?? `/os/agents/${config.agent_id}`,
    mcp_endpoint: config.mcp_endpoint,
    config_path: path,
  };
}

export type ProposeOptions = {
  baseUrl: string;
  token: string;
  /** The attached agent's id (Sato OS pins token-scoped proposals to it either way). */
  agentId?: string;
  /** Sato OS wallet id to propose against, when the agent has several. */
  walletId?: string;
  /** MCP path. Default "/api/os/mcp". */
  mcpEndpoint?: string;
  fetch?: SatoOsFetch;
  timeoutMs?: number;
  clock?: () => number;
};

export type ProposeResult = {
  proposal_id: string;
  status: string;
  approval_id: string | null;
  tier: string | null;
};

/** Builds the proposal tool arguments from a prepared intent. Pure; exported for inspection. */
export function proposalArguments(prepared: PreparedIntent, opts: { agentId?: string; walletId?: string } = {}): Record<string, unknown> {
  const u = prepared.unsigned;
  const base: Record<string, unknown> = {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.walletId ? { walletId: opts.walletId } : {}),
    humanSummary: prepared.summary.slice(0, 160),
  };
  const reason = {
    source: KIT_USER_AGENT,
    kit_intent_id: prepared.intent_id,
    action: prepared.action,
    expires_at: prepared.expires_at,
    policy: prepared.policy,
    simulation: prepared.simulation,
    fee_disclosure: prepared.fee_disclosure,
    unsigned: u,
  };
  let agentReason = JSON.stringify(reason);
  if (agentReason.length > 2000) {
    // Sato OS keeps 2000 chars of the reason; the full object travels in satoKitIntent.
    agentReason = JSON.stringify({ ...reason, unsigned: { ...u, ...("data" in u ? { data: `${u.data.slice(0, 66)}… (${u.data.length} chars; full in satoKitIntent)` } : {}) } }).slice(0, 2000);
  }
  base.agentReason = agentReason;
  base.satoKitIntent = prepared;
  if (u.kind === "x402_payment") {
    return { ...base, intentType: "x402_payment", chain: u.network, targetAddress: u.pay_to, targetLabel: u.resource.slice(0, 128), x402Url: u.resource, symbol: u.asset };
  }
  if (u.kind !== "evm_tx") {
    throw new Error(`Sato OS proposals take evm_tx and x402_payment intents; this one is ${u.kind}`);
  }
  return { ...base, intentType: "call_contract", chain: u.chain, targetAddress: u.to, targetLabel: prepared.action };
}

/**
 * Files a prepared intent as a Sato OS proposal. A refused intent
 * (policy.ok false) or an expired one is never sent. Nothing is signed here:
 * approval and signing happen inside Sato OS.
 */
export async function proposeIntent(prepared: PreparedIntent, opts: ProposeOptions): Promise<ProposeResult> {
  if (!prepared.policy.ok) {
    const rules = prepared.policy.refusals.map((r) => r.rule).join(", ") || "unnamed";
    throw new SatoOsError("refused_intent", `The kit policy refused this intent (${rules}); refused intents are never proposed.`);
  }
  const now = (opts.clock ?? Date.now)();
  if (Date.parse(prepared.expires_at) <= now) throw new SatoOsError("expired_intent", `Intent ${prepared.intent_id} expired at ${prepared.expires_at}.`);
  const base = trimBase(opts.baseUrl);
  const f = opts.fetch ?? fetch;
  const rpc = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: SATO_OS_PROPOSAL_TOOL, arguments: proposalArguments(prepared, { agentId: opts.agentId, walletId: opts.walletId }) },
  };
  const res = await f(`${base}${opts.mcpEndpoint ?? "/api/os/mcp"}`, {
    method: "POST",
    headers: headers(opts.token),
    body: JSON.stringify(rpc),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as
    | { result?: { isError?: boolean; content?: { text?: string }[]; structuredContent?: Record<string, unknown> }; error?: { message?: string } }
    | null;
  if (!res.ok) throw new SatoOsError("http", json?.error?.message ?? `Sato OS answered HTTP ${res.status}`, res.status);
  if (!json) throw new SatoOsError("bad_response", "Sato OS returned a non-JSON body.");
  if (json.error) throw new SatoOsError("rpc", json.error.message ?? "JSON-RPC error");
  const r = json.result;
  if (!r || r.isError) throw new SatoOsError("tool", r?.content?.[0]?.text ?? "Proposal tool failed.");
  const sc = r.structuredContent ?? {};
  if (typeof sc.error === "string") throw new SatoOsError("tool", sc.error);
  if (typeof sc.intentId !== "string" || typeof sc.status !== "string") throw new SatoOsError("bad_response", "Proposal response lacks intentId/status.");
  return {
    proposal_id: sc.intentId,
    status: sc.status,
    approval_id: typeof sc.approvalId === "string" ? sc.approvalId : null,
    tier: typeof sc.tier === "string" ? sc.tier : null,
  };
}
