// create-sato-agent — turn a plain-words goal into a runnable agent repo from a
// nightly-checked Sato Hub template.
//
// Contract (frozen for M1): see README.md. Exit codes: 0 ok · 2 refusal · 1 error.
// Everything the CLI touches from the outside world (env, stdin/stdout, fetch,
// child processes, cwd) comes in through `Io`, so tests drive it offline.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { readTarGz } from "./tar.js";

export const VERSION = "0.1.1";
export const USER_AGENT = `create-sato-agent/${VERSION}`;
export const DEFAULT_API = "https://satohub.ai/api/create";
/** The templates commit the --offline path copies from. Bumped by hand with each release. */
export const TEMPLATES_SHA = "fe1b4cbf7dca74e8daed2035f841e97f18b9f707";
export const TEMPLATES_TARBALL_URL = `https://codeload.github.com/satohubai/sato-agent-templates/tar.gz/${TEMPLATES_SHA}`;
export const DEFAULT_OFFLINE_TEMPLATE = "base-guarded-trader";

export const FRAMEWORKS = ["plain-ts", "agentkit", "eliza", "ai-sdk", "claude-agent-sdk", "openai-agents"] as const;
export const CHAINS = ["base", "base-sepolia", "solana"] as const;
export const NETWORKS = ["fork", "testnet", "mainnet"] as const;

/**
 * Environment variables that mean "a coding agent is driving this process".
 * Any of them set (non-empty) → agent mode → never prompt. `CODEX_*` is a prefix.
 */
export const AGENT_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "CODEX_SANDBOX",
  "CODEX_*",
  "GEMINI_CLI",
  "AGENT",
  "OPENCODE",
  "AIDER",
  "CLINE_ACTIVE",
  "GOOSE_TERMINAL",
  "AMP_AGENT",
  "WINDSURF_AGENT",
] as const;

export interface Io {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown };
  fetch?: typeof fetch;
  /** Runs a child process; returns its exit status. */
  run?: (cmd: string, args: string[], cwd: string) => number;
  /** Test hook: where --offline downloads from. Defaults to the pinned codeload URL. */
  tarballUrl?: string;
}

export interface Options {
  goal?: string;
  framework?: string;
  chain?: string;
  network?: string;
  template?: string;
  dir?: string;
  yes: boolean;
  install: boolean;
  git: boolean;
  dryRun: boolean;
  json: boolean;
  offline: boolean;
  acceptMainnetRisk: boolean;
  api: string;
  help: boolean;
  version: boolean;
  flagsPassed: boolean;
}

class Refusal extends Error {
  constructor(public code: string, message: string, public rule?: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
class CliError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const VALUE_FLAGS = new Set(["framework", "chain", "network", "template", "dir", "api"]);
const BOOL_FLAGS: Record<string, keyof Options> = {
  yes: "yes",
  y: "yes",
  "dry-run": "dryRun",
  json: "json",
  offline: "offline",
  "i-accept-mainnet-risk": "acceptMainnetRisk",
  help: "help",
  h: "help",
  version: "version",
};

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    yes: false, install: true, git: true, dryRun: false, json: false, offline: false,
    acceptMainnetRisk: false, api: DEFAULT_API, help: false, version: false, flagsPassed: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("-") || a === "-") { positional.push(a); continue; }
    o.flagsPassed = true;
    let name = a.replace(/^--?/, "");
    let value: string | undefined;
    const eq = name.indexOf("=");
    if (eq !== -1) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    if (name === "no-install") { o.install = false; continue; }
    if (name === "no-git") { o.git = false; continue; }
    if (VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new Refusal("invalid_request", `--${name} needs a value`, "cli.flag_value");
      }
      (o as unknown as Record<string, unknown>)[name] = value;
      continue;
    }
    const key = BOOL_FLAGS[name];
    if (!key) throw new Refusal("invalid_request", `unknown flag --${name}`, "cli.unknown_flag");
    (o as unknown as Record<string, unknown>)[key] = true;
  }
  if (positional.length) o.goal = positional.join(" ");
  return o;
}

export function detectAgent(env: Io["env"]): string | null {
  for (const name of AGENT_ENV_VARS) {
    if (name.endsWith("*")) {
      const p = name.slice(0, -1);
      const hit = Object.keys(env).find((k) => k.startsWith(p) && env[k]);
      if (hit) return hit;
    } else if (env[name]) return name;
  }
  return null;
}

/** Prompting is allowed only for a person at a TTY who passed no flags at all. */
export function canPrompt(opts: Options, io: Io): boolean {
  if (opts.flagsPassed) return false;
  if (!io.stdin.isTTY || !io.stdout.isTTY) return false;
  if (io.env.CI) return false;
  if (detectAgent(io.env)) return false;
  return true;
}

function ask(io: Io, question: string): Promise<string> {
  const rl = createInterface({ input: io.stdin, output: io.stdout as NodeJS.WritableStream });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "sato-agent";
}

interface FileOut { path: string; encoding: "utf8" | "base64"; content: string; mode?: number }
interface Plan {
  template: { id: string; version?: string; digest?: string; framework: string };
  files: FileOut[];
  env_names: string[];
  next_commands: string[];
  last_green: string | null;
  offline: boolean;
}

function safeRelPath(p: string): string {
  const n = normalize(p).replace(/\\/g, "/");
  if (!n || isAbsolute(p) || n.startsWith("../") || n === ".." || n.includes("/../") || /^[a-zA-Z]:/.test(p)) {
    throw new CliError("bad_path", `refusing to write outside the target directory: ${p}`);
  }
  return n;
}

async function planOnline(opts: Options, io: Io, network: string, mainnetAccepted: boolean): Promise<Plan> {
  const f = io.fetch ?? fetch;
  const body: Record<string, unknown> = { goal: opts.goal, network, format: "files" };
  if (opts.framework) body.framework = opts.framework;
  if (opts.chain) body.chain = opts.chain;
  if (opts.template) body.template = opts.template;
  if (network === "mainnet") body.mainnet_risk_accepted = mainnetAccepted;
  let res: Response;
  try {
    res = await f(opts.api, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new CliError("network_error", `could not reach ${opts.api}: ${(e as Error).message}. Try --offline.`);
  }
  let json: any;
  try { json = await res.json(); } catch { json = null; }
  if (res.status === 422 && json && json.ok === false) {
    throw new Refusal(String(json.error ?? "refused"), String(json.message ?? "refused"), json.rule, {
      ...(json.nearest ? { nearest: json.nearest } : {}),
      ...(json.blocked ? { blocked: json.blocked } : {}),
    });
  }
  if (!res.ok || !json || json.ok !== true || !Array.isArray(json.files)) {
    throw new CliError("bad_response", `unexpected response from ${opts.api} (HTTP ${res.status})`);
  }
  return {
    template: json.template,
    files: json.files,
    env_names: json.env_names ?? [],
    next_commands: json.next_commands ?? [],
    last_green: json.last_green ?? null,
    offline: false,
  };
}

async function planOffline(opts: Options, io: Io): Promise<Plan> {
  const f = io.fetch ?? fetch;
  const id = opts.template ?? DEFAULT_OFFLINE_TEMPLATE;
  const fw = opts.framework ?? "plain-ts";
  const url = io.tarballUrl ?? TEMPLATES_TARBALL_URL;
  let res: Response;
  try {
    res = await f(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new CliError("network_error", `could not download the templates tarball: ${(e as Error).message}`);
  }
  if (!res.ok) throw new CliError("download_failed", `templates tarball: HTTP ${res.status}`);
  const entries = readTarGz(new Uint8Array(await res.arrayBuffer()));
  const marker = `/templates/${id}/${fw}/`;
  const files: FileOut[] = [];
  for (const e of entries) {
    const at = e.path.indexOf(marker);
    if (at === -1 || at !== e.path.indexOf("/")) continue; // must sit directly under the archive root
    const rel = e.path.slice(at + marker.length);
    if (!rel || rel.split("/").some((seg) => seg === "node_modules" || seg === "..")) continue;
    files.push({ path: rel, encoding: "base64", content: e.data.toString("base64"), mode: e.mode });
  }
  if (!files.length) {
    throw new Refusal("no_template", `no template ${id}/${fw} in the pinned templates at ${TEMPLATES_SHA.slice(0, 12)}`, "offline.template_missing");
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const envExample = files.find((x) => x.path === ".env.example");
  const env_names = envExample
    ? Buffer.from(envExample.content, "base64").toString("utf8").split(/\r?\n/)
        .map((l) => /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(l)?.[1]).filter((x): x is string => !!x)
    : [];
  const hasLock = files.some((x) => x.path === "package-lock.json");
  let scripts: Record<string, string> = {};
  const pkg = files.find((x) => x.path === "package.json");
  if (pkg) { try { scripts = JSON.parse(Buffer.from(pkg.content, "base64").toString("utf8")).scripts ?? {}; } catch { /* ignore */ } }
  const next = [hasLock ? "npm ci" : "npm install"];
  if (envExample) next.push("cp .env.example .env");
  if (scripts.test) next.push("npm test");
  if (scripts.start) next.push("npm start");
  return { template: { id, framework: fw }, files, env_names, next_commands: next, last_green: null, offline: true };
}

function isEmptyDir(p: string): boolean {
  return !existsSync(p) || readdirSync(p).length === 0;
}

function defaultRun(cmd: string, args: string[], cwd: string): number {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
}

function help(): string {
  return `create-sato-agent ${VERSION}

Usage: create-sato-agent "<goal>" [options]
       npm create sato-agent -- "<goal>" [options]

  --framework <fw>          plain-ts | agentkit | eliza | ai-sdk | claude-agent-sdk | openai-agents
  --chain <chain>           base | base-sepolia | solana
  --network <net>           fork (default) | testnet | mainnet
  --template <id>           pick a template by id
  --dir <path>              target directory (default: slug of the template id); must be empty
  --yes                     accept defaults (never enables mainnet)
  --no-install              skip npm ci
  --no-git                  skip git init + first commit
  --dry-run                 print the plan, write nothing
  --json                    machine-readable output
  --offline                 copy the pinned template from GitHub; no server plan or manifest
  --i-accept-mainnet-risk   required with --network mainnet when not confirming interactively
  --api <url>               create endpoint (default ${DEFAULT_API})

Exit codes: 0 ok, 2 refused, 1 error. The goal is sent to Sato Hub to pick a template and is not stored.
`;
}

export async function main(io: Io): Promise<number> {
  let opts: Options | undefined;
  const out = (s: string) => { io.stdout.write(s); };
  const log = (s: string) => { if (!opts?.json) io.stderr.write(s + "\n"); };
  try {
    opts = parseArgs(io.argv);
    if (opts.help) { out(help()); return 0; }
    if (opts.version) { out(VERSION + "\n"); return 0; }
    const interactive = canPrompt(opts, io);

    if (!opts.goal && interactive) opts.goal = await ask(io, "What should the agent do? ");
    if (!opts.goal || !opts.goal.trim()) throw new Refusal("invalid_request", 'a goal is required: create-sato-agent "<goal>"', "create.goal_required");
    if (opts.goal.length > 500) throw new Refusal("invalid_request", "the goal is limited to 500 characters", "create.goal_too_long");
    if (opts.framework && !(FRAMEWORKS as readonly string[]).includes(opts.framework)) throw new Refusal("invalid_request", `unknown --framework ${opts.framework}`, "create.framework_unknown");
    if (opts.chain && !(CHAINS as readonly string[]).includes(opts.chain)) throw new Refusal("invalid_request", `unknown --chain ${opts.chain}`, "create.chain_unknown");

    let network = opts.network ?? "fork";
    if (!opts.network && interactive) {
      const a = (await ask(io, "Network — fork (default), testnet or mainnet? ")).toLowerCase();
      if (a) network = a;
    }
    if (!(NETWORKS as readonly string[]).includes(network)) throw new Refusal("network_not_supported", `unknown network ${network}`, "create.network_unknown");

    let mainnetAccepted = false;
    if (network === "mainnet") {
      if (opts.acceptMainnetRisk) mainnetAccepted = true;
      else if (interactive) {
        const a = (await ask(io, "Mainnet uses real funds. The agent can sign and send transactions within its policy. Continue? [y/N] ")).toLowerCase();
        mainnetAccepted = a === "y" || a === "yes";
        if (!mainnetAccepted) throw new Refusal("network_mainnet_not_accepted", "mainnet was not confirmed", "cli.mainnet_confirm");
      } else {
        throw new Refusal("network_mainnet_not_accepted", "mainnet needs --i-accept-mainnet-risk (or an interactive confirm); --yes does not enable it", "cli.mainnet_confirm");
      }
    }
    if (opts.offline && network === "mainnet") throw new Refusal("network_mainnet_not_enabled", "--offline does not create mainnet agents", "cli.offline_mainnet");

    // Fail fast on an explicit, non-empty --dir before any network call.
    if (opts.dir && !isEmptyDir(resolve(io.cwd, opts.dir))) throw new Refusal("dir_not_empty", `${opts.dir} is not empty`, "cli.dir_not_empty");

    const plan = opts.offline ? await planOffline(opts, io) : await planOnline(opts, io, network, mainnetAccepted);
    const dirArg = opts.dir ?? slug(plan.template.id);
    const target = resolve(io.cwd, dirArg);
    if (!isEmptyDir(target)) throw new Refusal("dir_not_empty", `${dirArg} is not empty`, "cli.dir_not_empty");
    const paths = plan.files.map((f) => safeRelPath(f.path));

    const nextCommands = [`cd ${dirArg}`, ...plan.next_commands];
    if (plan.offline) log(`--offline: copied templates/${plan.template.id}/${plan.template.framework}/ at ${TEMPLATES_SHA.slice(0, 12)} without a server plan or signed manifest (no sato.create lock).`);

    if (opts.dryRun) {
      if (opts.json) {
        out(JSON.stringify({ ok: true, dry_run: true, dir: target, template: plan.template, files_written: [], files: paths, env_names: plan.env_names, next_commands: nextCommands, last_green: plan.last_green, offline: plan.offline }) + "\n");
      } else {
        out(`Would create ${target} from ${plan.template.id} (${plan.template.framework}):\n${paths.map((p) => "  " + p).join("\n")}\n`);
      }
      return 0;
    }

    for (let i = 0; i < plan.files.length; i++) {
      const f = plan.files[i]!;
      const dest = join(target, paths[i]!);
      if (!dest.startsWith(target + sep)) throw new CliError("bad_path", `refusing to write outside the target directory: ${f.path}`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.encoding === "base64" ? Buffer.from(f.content, "base64") : f.content);
      if (f.mode && f.mode & 0o111) chmodSync(dest, 0o755);
    }
    const run = io.run ?? defaultRun;
    if (opts.install) {
      const lock = paths.includes("package-lock.json");
      log(`Running npm ${lock ? "ci" : "install"}…`);
      if (run("npm", [lock ? "ci" : "install"], target) !== 0) log("npm install failed; run it yourself in the new directory.");
    }
    if (opts.git) {
      const ok = run("git", ["init", "-q"], target) === 0 && run("git", ["add", "-A"], target) === 0 &&
        run("git", ["commit", "-q", "-m", `Create from ${plan.template.id} (create-sato-agent ${VERSION})`], target) === 0;
      if (!ok) log("git init/commit did not complete; the files are written.");
    }
    const nextAfter = nextCommands.filter((c) => !(opts!.install && (c === "npm ci" || c === "npm install")));

    if (opts.json) {
      out(JSON.stringify({ ok: true, dir: target, template: plan.template, files_written: paths, env_names: plan.env_names, next_commands: nextAfter, last_green: plan.last_green }) + "\n");
    } else {
      out(`\nCreated ${dirArg} from ${plan.template.id} (${plan.template.framework}).\n`);
      if (plan.env_names.length) out(`Set in .env: ${plan.env_names.join(", ")}\n`);
      out(`\nNext:\n${nextAfter.map((c) => "  " + c).join("\n")}\n`);
      out(plan.last_green ? `\nThis template last passed its nightly checks on ${plan.last_green}. https://satohub.ai/status\n` : `\nNightly check status: not available. https://satohub.ai/status\n`);
    }
    return 0;
  } catch (e) {
    const json = opts?.json ?? io.argv.includes("--json");
    if (e instanceof Refusal) {
      if (json) out(JSON.stringify({ ok: false, error: e.code, message: e.message, ...(e.rule ? { rule: e.rule } : {}), ...e.extra }) + "\n");
      else io.stderr.write(`Refused (${e.rule ?? e.code}): ${e.message}\n`);
      return 2;
    }
    const code = e instanceof CliError ? e.code : "internal_error";
    if (json) out(JSON.stringify({ ok: false, error: code, message: (e as Error).message }) + "\n");
    else io.stderr.write(`Error: ${(e as Error).message}\n`);
    return 1;
  }
}
