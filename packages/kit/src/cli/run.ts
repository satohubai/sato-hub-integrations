// CLI builder owns this file.
// runCli(argv, io) → exit code: 0 ok, 2 refused by policy, 1 error.
// Commands: read | prepare | execute --intent <id> | mcp [--toolsets] | doctor; all take --json.
//
// Cold start matters (npx sato-kit --help must answer in well under 10 s), so
// this file imports nothing heavy at the top: the config loader (viem), the
// tool surface and the MCP server are loaded only by the command that needs them.
import { KIT_VERSION, kitUserAgent } from "../version.js";
// drift.ts imports only node:fs and node:path, so it is cheap to load eagerly for its formatter.
import { driftLines } from "./drift.js";
import type { DriftReport } from "./drift.js";

export type CliIo = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  isTTY: boolean;
  /** Used by doctor to read Sato Status and template drift. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
};

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_REFUSED = 2;

/** How long doctor waits for Sato Status before reporting it unavailable. */
export const DOCTOR_STATUS_TIMEOUT_MS = 3_000;
/** How long doctor waits for the template drift check before reporting it unavailable. */
export const DOCTOR_DRIFT_TIMEOUT_MS = 3_000;

export const HELP = `sato-kit ${KIT_VERSION} — prepare -> execute for onchain agent actions

Usage:
  sato-kit read <action> --input '<json>'      run a read-only action
  sato-kit prepare <action> --input '<json>'   build an intent; nothing is signed
  sato-kit execute --intent <intent_id>        hand one prepared intent to the signer
  sato-kit mcp [--toolsets default|all]        local MCP server over stdio
  sato-kit doctor                              check config, Sato Status and template drift

<action> is an action id (swap.prepare) or a tool name (swap_prepare).
Options: --json  --policy <file>  --rpc <url>  --help  --version
Config: ./policy.json, ./.sato/, SATO_RPC_URL_<CHAIN>, SATO_SIGNER. Fork network by default.
Exit: 0 ok, 2 refused by policy, 1 error.
`;

type Command = "read" | "prepare" | "execute" | "mcp" | "doctor";
const COMMANDS: readonly Command[] = ["read", "prepare", "execute", "mcp", "doctor"];

/** Value flags each command accepts (--json is accepted everywhere). */
const VALUE_FLAGS: Record<Command, readonly string[]> = {
  read: ["--input", "--policy", "--rpc"],
  prepare: ["--input", "--policy", "--rpc"],
  // execute takes the intent id and nothing else: every parameter was bound at prepare.
  execute: ["--intent"],
  mcp: ["--toolsets", "--policy", "--rpc"],
  doctor: ["--policy", "--rpc"],
};

type Refusal = { rule: string; limit: string; observed: string; message: string };
type CliErrorBody = { code: string; message: string; refusals?: Refusal[] };

class CliError extends Error {
  constructor(public code: string, message: string, public exit: number = EXIT_ERROR, public refusals?: Refusal[]) {
    super(message);
  }
}

type Parsed = { command: Command | null; positionals: string[]; flags: Map<string, string>; json: boolean; help: boolean; version: boolean };

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = { command: null, positionals: [], flags: new Map(), json: false, help: false, version: false };
  const all = new Set(Object.values(VALUE_FLAGS).flat());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") { out.json = true; continue; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--version" || a === "-v") { out.version = true; continue; }
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      let value: string | undefined = eq > 0 ? a.slice(eq + 1) : undefined;
      if (!all.has(name)) {
        const why = out.command === "execute" ? "; execute takes only --intent <intent_id> (every parameter was bound when the intent was prepared)" : "";
        throw new CliError("usage", `unknown option ${name}${why}`);
      }
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined) throw new CliError("usage", `${name} needs a value`);
        i++;
      }
      if (out.flags.has(name)) throw new CliError("usage", `${name} given more than once`);
      out.flags.set(name, value);
      continue;
    }
    if (out.command === null && out.positionals.length === 0) {
      if (!(COMMANDS as readonly string[]).includes(a)) throw new CliError("usage", `unknown command "${a}"; expected one of ${COMMANDS.join(", ")}`);
      out.command = a as Command;
      continue;
    }
    out.positionals.push(a);
  }
  return out;
}

function checkFlags(p: Parsed, cmd: Command): void {
  for (const name of p.flags.keys()) {
    if (!VALUE_FLAGS[cmd].includes(name)) {
      const why = cmd === "execute" ? "; execute takes only --intent <intent_id> (every parameter was bound when the intent was prepared)" : "";
      throw new CliError("usage", `${cmd} does not accept ${name}${why}`);
    }
  }
}

function parseInput(p: Parsed): unknown {
  const raw = p.flags.get("--input");
  if (raw === undefined) throw new CliError("usage", "--input '<json>' is required");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CliError("usage", `--input is not valid JSON: ${(e as Error).message}`);
  }
}

function refusalsOf(e: unknown): Refusal[] | undefined {
  const r = (e as { refusals?: unknown } | null)?.refusals;
  return Array.isArray(r) && r.length > 0 ? (r as Refusal[]) : undefined;
}

function toCliError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const refusals = refusalsOf(e);
  if (refusals) return new CliError("refused", message, EXIT_REFUSED, refusals);
  if (/refused by the policy pre-flight/.test(message)) return new CliError("refused", message, EXIT_REFUSED);
  if (e instanceof Error && e.name === "KitConfigError") return new CliError("config", message);
  if (e instanceof Error && e.name === "ActionInputError") return new CliError("invalid_input", message);
  return new CliError("error", message);
}

async function loadKit(p: Parsed, io: CliIo) {
  const { loadKitFromEnv } = await import("../config/index.js");
  return loadKitFromEnv({
    cwd: io.cwd,
    env: io.env,
    policyPath: p.flags.get("--policy"),
    rpc: p.flags.get("--rpc"),
    fetch: io.fetch,
  });
}

async function resolveAction(loaded: { actions: readonly unknown[] }, name: string | undefined, want: "read" | "prepare") {
  if (!name) throw new CliError("usage", `${want} needs an <action> (an action id like chain.read or a tool name like chain_read)`);
  const { toolDefinitions, resolveTool } = await import("../surface/index.js");
  const defs = toolDefinitions({ actions: loaded.actions as never, toolsets: "all" });
  const def = resolveTool(defs, name);
  if (!def || !def.oda_id) throw new CliError("unknown_action", `unknown action "${name}"`);
  if (def.kind !== want) {
    const other = def.kind === "prepare" ? "prepare" : "read";
    throw new CliError("wrong_command", `${def.oda_id} is a ${def.kind} action; use sato-kit ${other} ${def.name}`);
  }
  return def.oda_id;
}

type Out = Record<string, unknown>;

async function cmdRead(p: Parsed, io: CliIo): Promise<Out> {
  if (p.positionals.length > 1) throw new CliError("usage", `unexpected argument "${p.positionals[1]}"`);
  const input = parseInput(p);
  const loaded = await loadKit(p, io);
  const id = await resolveAction(loaded, p.positionals[0], "read");
  const result = await loaded.kit.read(id, input);
  return { action: id, result };
}

async function cmdPrepare(p: Parsed, io: CliIo): Promise<Out> {
  if (p.positionals.length > 1) throw new CliError("usage", `unexpected argument "${p.positionals[1]}"`);
  const input = parseInput(p);
  const loaded = await loadKit(p, io);
  const id = await resolveAction(loaded, p.positionals[0], "prepare");
  const intent = await loaded.kit.prepare(id, input);
  if (!intent.policy.ok) {
    const list = intent.policy.refusals.map((r) => `${r.rule} (limit ${r.limit}, observed ${r.observed})`).join("; ");
    throw new CliError("refused", `${id}: the policy pre-flight refused intent ${intent.intent_id}: ${list}`, EXIT_REFUSED, intent.policy.refusals as Refusal[]);
  }
  return { action: id, intent };
}

async function cmdExecute(p: Parsed, io: CliIo): Promise<Out> {
  if (p.positionals.length > 0) throw new CliError("usage", `unexpected argument "${p.positionals[0]}"; execute takes only --intent <intent_id>`);
  const id = p.flags.get("--intent");
  if (!id) throw new CliError("usage", "execute needs --intent <intent_id>");
  const loaded = await loadKit(p, io);
  const receipt = await loaded.kit.execute({ intent_id: id });
  return { receipt };
}

async function readActionsStatus(fetchFn: typeof fetch | undefined): Promise<{ doc: unknown | null; reason?: string; url: string; source: string | null }> {
  const { readActionsStatusDoc } = await import("../surface/index.js");
  const f = fetchFn ?? globalThis.fetch;
  const r = await readActionsStatusDoc(f as never, {
    timeoutMs: DOCTOR_STATUS_TIMEOUT_MS,
    headers: { "user-agent": kitUserAgent() },
  });
  if (r.doc === null) return { doc: null, reason: r.reason, url: r.url, source: null };
  const doc = r.doc as { schema?: unknown; actions?: unknown };
  if (!doc || doc.schema !== "sato.action-status/v1" || !Array.isArray(doc.actions)) {
    return { doc: null, reason: `Sato Status did not return a sato.action-status/v1 document at ${r.url}`, url: r.url, source: null };
  }
  return { doc, url: r.url, source: r.source };
}

async function cmdDoctor(p: Parsed, io: CliIo): Promise<Out> {
  if (p.positionals.length > 0) throw new CliError("usage", `unexpected argument "${p.positionals[0]}"`);
  const [{ toolDefinitions, buildStatus }, { coreActions }] = await Promise.all([
    import("../surface/index.js"),
    import("../actions/registry.js"),
  ]);
  const statusP = readActionsStatus(io.fetch);
  const { readTemplateDrift } = await import("./drift.js");
  const driftP = readTemplateDrift(io.cwd, (io.fetch ?? globalThis.fetch) as never, {
    timeoutMs: DOCTOR_DRIFT_TIMEOUT_MS,
    userAgent: kitUserAgent(),
  });

  let policy: Out;
  let network: string | null = null;
  let signer: Out = { configured: false };
  let status: ReturnType<typeof buildStatus> | null = null;
  const actions = coreActions();
  // Core actions only: the rows Sato Status checks nightly for this kit.
  const defs = toolDefinitions({ actions, toolsets: "all" }).filter((d) => d.kind === "read" || d.kind === "prepare");
  try {
    const loaded = await loadKit(p, io);
    policy = { valid: true, path: loaded.policyPath, source: loaded.policyPath ? "file" : "default" };
    network = loaded.network;
    if (loaded.signer) signer = { configured: true, kind: loaded.signer.kind };
    const s = await statusP;
    status = buildStatus({ policy: loaded.policy, tools: defs, signerKind: loaded.signer?.kind ?? null, actionsStatus: s.doc });
  } catch (e) {
    policy = { valid: false, error: e instanceof Error ? e.message : String(e) };
  }
  const s = await statusP;
  const drift = await driftP;
  const rows = status
    ? status.tools
    : defs.map((d) => ({ name: d.name, result: s.doc ? "not_evaluated" : "unknown" }));
  return {
    result: {
      kit_version: KIT_VERSION,
      node_version: process.versions.node,
      policy,
      network,
      signer,
      status_url: s.url,
      status_source: s.doc ? "reachable" : "unreachable",
      status_answered_by: s.source,
      ...(s.reason ? { status_reason: s.reason } : {}),
      actions: rows.map((r) => {
        const d = defs.find((x) => x.name === r.name);
        return { id: d?.oda_id ?? null, ...r };
      }),
      drift,
    },
  };
}

function human(command: Command, out: Out): string {
  if (command === "doctor") {
    const r = out.result as Out & { actions: Array<Out> };
    const pol = r.policy as Out;
    const sig = r.signer as Out;
    const lines = [
      `sato-kit ${r.kit_version} on node ${r.node_version}`,
      `policy: ${pol.valid ? (pol.path ?? "default (no policy.json)") : `INVALID — ${pol.error}`}`,
      `network: ${r.network ?? "unknown"}`,
      `signer: ${sig.configured ? sig.kind : "none configured (prepare works; execute refuses)"}`,
      `Sato Status: ${r.status_source}${r.status_reason ? ` — ${r.status_reason}` : ""}`,
    ];
    for (const a of r.actions) {
      const extra = a.result === "red" ? ` (failing step ${a.failing_step ?? "?"}, upstream ${a.upstream_version ?? "?"})` : "";
      lines.push(`  ${String(a.id ?? a.name).padEnd(18)} ${a.result}${a.last_green ? `, last passed its checks ${a.last_green}` : ""}${extra}`);
    }
    if (r.drift) lines.push(...driftLines(r.drift as DriftReport));
    return lines.join("\n") + "\n";
  }
  return JSON.stringify(out.result ?? out.intent ?? out.receipt, null, 2) + "\n";
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let p: Parsed | null = null;
  // Known before parsing, so a usage error still names its command.
  let command: Command | null = (argv.find((a) => (COMMANDS as readonly string[]).includes(a)) as Command | undefined) ?? null;
  const json = argv.includes("--json");
  try {
    p = parseArgs(argv);
    command = p.command;
    if (p.version && !command) {
      io.stdout(json ? JSON.stringify({ ok: true, command: "version", result: { kit_version: KIT_VERSION } }) + "\n" : `${KIT_VERSION}\n`);
      return EXIT_OK;
    }
    if (p.help || !command) {
      if (!command && !p.help) throw new CliError("usage", "no command given; run sato-kit --help");
      io.stdout(HELP);
      return EXIT_OK;
    }
    checkFlags(p, command);
    if (command === "mcp") {
      if (p.positionals.length > 0) throw new CliError("usage", `unexpected argument "${p.positionals[0]}"`);
      const toolsets = p.flags.get("--toolsets") ?? "default";
      if (toolsets !== "default" && toolsets !== "all") throw new CliError("usage", "--toolsets must be default or all");
      const { runStdio } = await import("../mcp/index.js");
      await runStdio({ cwd: io.cwd, env: io.env, policyPath: p.flags.get("--policy"), rpc: p.flags.get("--rpc"), toolsets });
      return EXIT_OK;
    }
    const out = command === "read" ? await cmdRead(p, io)
      : command === "prepare" ? await cmdPrepare(p, io)
      : command === "execute" ? await cmdExecute(p, io)
      : await cmdDoctor(p, io);
    io.stdout(json ? JSON.stringify({ ok: true, command, ...out }) + "\n" : human(command, out));
    return EXIT_OK;
  } catch (e) {
    const err = toCliError(e);
    const body: CliErrorBody = { code: err.code, message: err.message };
    if (err.refusals) body.refusals = err.refusals;
    if (json) {
      io.stdout(JSON.stringify({ ok: false, command: command ?? null, error: body }) + "\n");
    } else {
      io.stderr(`sato-kit: ${err.message}\n`);
      for (const r of err.refusals ?? []) io.stderr(`  refused: ${r.rule} (limit ${r.limit}, observed ${r.observed}) — ${r.message}\n`);
    }
    return err.exit;
  }
}
