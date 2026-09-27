// SKELETON (M1). loadKitFromEnv — the ONE way the CLI and the local MCP server
// build a kit from a working directory. Both doors call this; neither reads
// policy.json, .sato/ or the environment on its own.
//
// What it reads:
//   policy       <cwd>/policy.json, or opts.policyPath. Parsed with
//                parsePolicyFile. No file → the default policy (fork network).
//                A file that does not parse is an error, never silently the default.
//   network      opts.network ?? policy.network. The effective network can only
//                be as permissive as the policy file: asking for testnet or
//                mainnet when the policy says less is refused. Mainnet is
//                reached only by a policy.json that says "mainnet".
//   .sato/       <cwd>/.sato — intents/ (fileIntentStore), intent.key
//                (loadOrCreateIntentSecret, mode 0600), receipts.jsonl
//                (fileReceiptLog). Gitignore it: it holds a secret and unsigned payloads.
//   RPC          per chain: opts.rpc (a URL for every chain, or a map chain → URL),
//                else env SATO_RPC_URL_<CHAIN> (upper-case, "-" → "_", e.g.
//                SATO_RPC_URL_BASE_SEPOLIA), else — in fork mode only —
//                http://127.0.0.1:8545 (anvil). Testnet/mainnet with no URL for a
//                chain fails when that chain is first used, naming the variable.
//   signer       NONE by default: prepare works, execute refuses ("no signer
//                configured"). SATO_SIGNER=viem-local-fork (fork network only) adds
//                viemLocalSigner({ fork: true }) against the anvil RPC, keyed by
//                SATO_FORK_PRIVATE_KEY when set (an anvil dev key) or a throwaway
//                in-memory key otherwise. Any other SATO_SIGNER value is an error.
//                Real signers (OWS, CDP, …) are wired in code, not by env.
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { POLICY_NETWORKS, POLICY_SCHEMA_ID, parsePolicyFile } from "../spec/index.js";
import type { OdaChain, PolicyNetwork, SatoPolicy } from "../spec/index.js";
import type { AnyAction, Clock, FixtureSource, Kit, KitFetch, RpcProvider, Signer } from "../types.js";
import { coreActions } from "../actions/registry.js";
import { createKit } from "../kit.js";
import { fileIntentStore, loadOrCreateIntentSecret } from "../intent/store.js";
import { fileReceiptLog } from "../receipts/log.js";
import { viemLocalSigner } from "../signers/viem-local.js";

export const DEFAULT_FORK_RPC_URL = "http://127.0.0.1:8545";
export const SATO_DIR = ".sato";
export const POLICY_FILE = "policy.json";

export type LoadKitOptions = {
  cwd: string;
  policyPath?: string;
  /** One URL for every chain, or chain → URL. Wins over env. */
  rpc?: string | Partial<Record<OdaChain, string>>;
  network?: PolicyNetwork;
  /** Defaults to process.env. Injected in tests. */
  env?: Record<string, string | undefined>;
  fetch?: KitFetch;
  clock?: Clock;
  fixtures?: FixtureSource;
  /** Defaults to coreActions(). */
  actions?: readonly AnyAction[];
  /** Test seam: builds the PublicClient for a URL. Default viem http transport. */
  makeClient?: (url: string, chain: OdaChain) => PublicClient;
};

export type LoadedKit = {
  kit: Kit;
  policy: SatoPolicy;
  network: PolicyNetwork;
  /** Absolute path of the policy file, or null when the default policy is in force. */
  policyPath: string | null;
  satoDir: string;
  signer: Signer | null;
  actions: readonly AnyAction[];
  /** chain → URL resolved so far (fork default included). */
  rpcUrl(chain: OdaChain): string;
};

export class KitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitConfigError";
  }
}

const RANK: Record<PolicyNetwork, number> = { fork: 0, testnet: 1, mainnet: 2 };

export function rpcEnvName(chain: OdaChain): string {
  return `SATO_RPC_URL_${chain.toUpperCase().replace(/-/g, "_")}`;
}

async function readPolicy(path: string, explicit: boolean): Promise<{ policy: SatoPolicy; path: string | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && !explicit) {
      const d = parsePolicyFile({ schema: POLICY_SCHEMA_ID });
      if (!d.ok) throw new KitConfigError(d.error);
      return { policy: d.policy, path: null };
    }
    throw new KitConfigError(`cannot read policy file ${path}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new KitConfigError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = parsePolicyFile(json);
  if (!parsed.ok) throw new KitConfigError(`${path}: ${parsed.error}`);
  return { policy: parsed.policy, path };
}

export async function loadKitFromEnv(opts: LoadKitOptions): Promise<LoadedKit> {
  const env = opts.env ?? process.env;
  const cwd = resolve(opts.cwd);
  const explicit = opts.policyPath !== undefined;
  const policyFile = explicit ? (isAbsolute(opts.policyPath!) ? opts.policyPath! : join(cwd, opts.policyPath!)) : join(cwd, POLICY_FILE);
  const { policy: filePolicy, path: policyPath } = await readPolicy(policyFile, explicit);

  const network = opts.network ?? filePolicy.network;
  if (!(POLICY_NETWORKS as readonly string[]).includes(network)) {
    throw new KitConfigError(`network must be one of ${POLICY_NETWORKS.join(", ")}`);
  }
  if (RANK[network] > RANK[filePolicy.network]) {
    throw new KitConfigError(
      `network "${network}" asked for, but the policy allows "${filePolicy.network}". Set "network": "${network}" in ${policyPath ?? POLICY_FILE} to opt in.`,
    );
  }
  const policy: SatoPolicy = { ...filePolicy, network };

  const makeClient = opts.makeClient ?? ((url: string) => createPublicClient({ transport: http(url) }) as PublicClient);
  const clients = new Map<string, PublicClient>();
  function rpcUrl(chain: OdaChain): string {
    const o = opts.rpc;
    const fromOpts = typeof o === "string" ? o : o?.[chain];
    const url = fromOpts ?? env[rpcEnvName(chain)] ?? (network === "fork" ? DEFAULT_FORK_RPC_URL : undefined);
    if (!url) throw new KitConfigError(`no RPC URL for ${chain} on ${network}: set ${rpcEnvName(chain)} or pass --rpc`);
    return url;
  }
  const rpc: RpcProvider = (chain) => {
    const url = rpcUrl(chain);
    let c = clients.get(`${chain} ${url}`);
    if (!c) {
      c = makeClient(url, chain);
      clients.set(`${chain} ${url}`, c);
    }
    return c;
  };

  let signer: Signer | null = null;
  const signerEnv = env.SATO_SIGNER;
  if (signerEnv !== undefined && signerEnv !== "") {
    if (signerEnv !== "viem-local-fork") throw new KitConfigError(`SATO_SIGNER="${signerEnv}" is not supported; the only env signer is viem-local-fork`);
    if (network !== "fork") throw new KitConfigError(`SATO_SIGNER=viem-local-fork works on the fork network only (network is ${network})`);
    const key = env.SATO_FORK_PRIVATE_KEY;
    signer = key
      ? viemLocalSigner({ privateKey: key as `0x${string}`, rpc, fork: true })
      : viemLocalSigner({ generate: true, rpc, fork: true });
  }

  const satoDir = join(cwd, SATO_DIR);
  const secret = await loadOrCreateIntentSecret(satoDir);
  const actions = opts.actions ?? coreActions();
  const kit = createKit({
    policy,
    secret,
    rpc,
    actions,
    signer: signer ?? undefined,
    intents: fileIntentStore(join(satoDir, "intents")),
    receipts: fileReceiptLog(join(satoDir, "receipts.jsonl")),
    fetch: opts.fetch,
    clock: opts.clock,
    fixtures: opts.fixtures,
  });
  return { kit, policy, network, policyPath, satoDir, signer, actions, rpcUrl };
}
