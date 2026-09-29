// ADAPTERS — the migration window (scope §16.2 #4, K2): consume an existing
// @coinbase/agentkit ActionProvider as kit actions, so a builder who already
// runs AgentKit providers gets the kit's guarantees without rewriting them.
//
//   const { actions, not_consumable } = fromAgentKitProvider(erc20ActionProvider(), { chain: "base" });
//   const kit = createKit({ ...opts, actions: [...coreActions(), ...actions] });
//
// HOW A WRITE RUNS. The provider's own invoke() runs against a CAPTURING
// wallet provider: it implements the AgentKit EvmWalletProvider surface, reads
// go to the kit's RPC (ctx.rpc), and sendTransaction RECORDS the transaction
// and returns a deterministic placeholder hash instead of sending. Nothing is
// signed or broadcast while the provider runs. Exactly one captured
// transaction becomes the intent's UnsignedEvmTx, and from there it is an
// ordinary kit intent: simulate -> pre-flight -> execute(intent_id) with the
// kit's signer, once.
//
// REFUSED, with the reason, and never partially executed (nothing was sent):
//   - the action tried to send more than one transaction (one intent is one tx);
//   - the action tried to sign a message, typed data, a hash or a raw tx;
//   - the action sent no transaction (its own message is passed through);
//   - a transaction with no `to` (a contract deployment).
//
// READS. An action classified as a read (opts.reads, or a get_/check_/list_…
// name) becomes a ReadAction that runs against the same capturing wallet; a
// "read" that tries to send or sign is refused, so a wrong classification
// cannot move funds.
//
// SCHEMAS. Each action's zod schema is turned into a JSON Schema and put
// through the portable-schema lint (spec/lint.ts). An amount-named string with
// no pattern is narrowed to a decimal-number pattern (the provider parses it as
// a decimal anyway) and that narrowing is listed in `tightened`. Anything that
// still is not portable is listed in `not_consumable` with the lint's reasons —
// it is not faked into a tool.
//
// DISCLOSED, NOT HIDDEN: AgentKit's own @CreateAction decorator posts an
// invocation analytics event (action name, wallet address, network) to
// cca-lite.coinbase.com on every invoke, with no opt-out in the pinned
// version. That is the provider's code, it runs here as it would in AgentKit,
// and the kit neither blocks nor adds to it. The capturing wallet itself makes
// no network call (its constructor's analytics hook is a no-op).
//
// VENUE NEUTRALITY (§0.3): a consumed action is not ranked, labelled or gated
// differently from a core action because of whose code it is.
import type { PublicClient } from "viem";
import { EvmWalletProvider } from "@coinbase/agentkit";
import type { Action, ActionProvider, Network, WalletProvider } from "@coinbase/agentkit";
import { ACTION_SCHEMA_ID, lintDescription, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, JsonSchemaObject, UnsignedEvmTx } from "../spec/index.js";
import { DECIMAL_PATTERN, factsFromTx, segment, toBig, zodToPortable } from "./_consume.js";
export { factsFromTx } from "./_consume.js";
import type { ActionContext, AnyAction, PrepareAction, PrepareBuild, ReadAction } from "../types.js";
import { ActionInputError, EVM_CHAIN_IDS } from "../actions/_util.js";
import type { EvmChain } from "../actions/_util.js";

/** The exact @coinbase/agentkit version this adapter is tested against (the devDependency). */
export const AGENTKIT_PIN = { "@coinbase/agentkit": "0.10.4" } as const;

/** AgentKit network ids for the kit's EVM chains. */
export const AGENTKIT_NETWORK_IDS: Record<EvmChain, string> = {
  ethereum: "ethereum-mainnet",
  sepolia: "ethereum-sepolia",
  base: "base-mainnet",
  "base-sepolia": "base-sepolia",
  arbitrum: "arbitrum-mainnet",
  "arbitrum-sepolia": "arbitrum-sepolia",
  optimism: "optimism-mainnet",
  "optimism-sepolia": "optimism-sepolia",
  polygon: "polygon-mainnet",
};

const READ_NAME = /^(get|check|list|fetch|read|query|search|lookup)_/;

export type FromAgentKitOptions = {
  /** The chain every consumed action runs on. */
  chain: EvmChain;
  /** Sender used when the kit has no signer (prepare only; execute still needs a signer). */
  from?: `0x${string}`;
  /** AgentKit action names (without the provider prefix) to treat as reads. Default: get_/check_/list_… names. */
  reads?: readonly string[];
  /** First id segment. Default "agentkit". */
  idPrefix?: string;
};

export type NotConsumable = { action: string; reason: string };

export type ConsumedAction = {
  /** The AgentKit action name, e.g. "ERC20ActionProvider_transfer". */
  agentkit_name: string;
  id: string;
  kind: "read" | "prepare";
  /** Property paths whose schema was narrowed to a decimal pattern. */
  tightened: string[];
  /** Set when the provider's description failed the copy lint and a plain one was used. */
  description_note: string | null;
};

export type FromAgentKitResult = {
  actions: AnyAction[];
  consumed: ConsumedAction[];
  not_consumable: NotConsumable[];
};

/** What the capturing wallet saw. */
export type Captured = {
  txs: Array<{ to?: string; data?: string; value?: bigint | string | number }>;
  signs: string[];
};

export class AgentKitCaptureRefused extends Error {
  readonly captured: Captured;
  constructor(message: string, captured: Captured) {
    super(message);
    this.name = "AgentKitCaptureRefused";
    this.captured = captured;
  }
}

function placeholderHash(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/**
 * An AgentKit EvmWalletProvider that never sends or signs. Reads go to the
 * client; sendTransaction records and returns a placeholder hash; every sign
 * method records the attempt and throws.
 */
export class CapturingWalletProvider extends EvmWalletProvider {
  readonly captured: Captured = { txs: [], signs: [] };
  readonly #address: `0x${string}`;
  readonly #network: Network;
  readonly #client: () => PublicClient;

  constructor(address: `0x${string}`, network: Network, client: () => PublicClient) {
    super();
    this.#address = address;
    this.#network = network;
    this.#client = client;
  }
  getAddress(): string { return this.#address; }
  getNetwork(): Network { return this.#network; }
  getName(): string { return "sato_kit_capturing_wallet"; }
  // AgentKit bundles its own viem; the kit's client is the same runtime shape.
  getPublicClient(): any { return this.#client(); }
  async getBalance(): Promise<bigint> { return this.#client().getBalance({ address: this.#address }); }
  async readContract(params: any): Promise<any> { return this.#client().readContract(params); }
  async sendTransaction(tx: any): Promise<`0x${string}`> {
    this.captured.txs.push({ to: tx?.to, data: tx?.data, value: tx?.value });
    return placeholderHash(this.captured.txs.length);
  }
  async nativeTransfer(to: string, value: string): Promise<string> {
    return this.sendTransaction({ to, value: BigInt(value) });
  }
  async waitForTransactionReceipt(hash: `0x${string}`): Promise<any> {
    // A placeholder: nothing was sent. The provider's message built on it is discarded.
    return { status: "success", transactionHash: hash, placeholder: true };
  }
  #refuseSign(kind: string): never {
    this.captured.signs.push(kind);
    throw new Error(`sato-kit: ${kind} is not captured; the kit consumes actions that send one transaction`);
  }
  async sign(_hash: `0x${string}`): Promise<`0x${string}`> { return this.#refuseSign("sign"); }
  async signMessage(_m: string | Uint8Array): Promise<`0x${string}`> { return this.#refuseSign("signMessage"); }
  async signTypedData(_t: any): Promise<`0x${string}`> { return this.#refuseSign("signTypedData"); }
  async signTransaction(_t: any): Promise<`0x${string}`> { return this.#refuseSign("signTransaction"); }
}
// AgentKit's WalletProvider constructor schedules an analytics call; the capturing wallet makes no network call of its own.
Object.defineProperty(CapturingWalletProvider.prototype, "trackInitialization", { value() {}, writable: true, configurable: true });

/** A provider's schema as a portable JSON Schema, or the reasons it is not one. */
export function agentKitSchemaToPortable(schema: unknown): ReturnType<typeof zodToPortable> {
  return zodToPortable(schema, DECIMAL_PATTERN);
}

// ── descriptors ────────────────────────────────────────────────────────────────

function shortName(providerClass: string, full: string): string {
  const p = `${providerClass}_`;
  return full.startsWith(p) ? full.slice(p.length) : full;
}

function describeText(provider: string, action: string, kind: "read" | "prepare", own: string): { text: string; note: string | null } {
  const lead = kind === "read"
    ? `Runs the AgentKit ${provider} provider's ${action} action as a read. It runs against a wallet that cannot send or sign; an attempt to send or sign is refused.`
    : `Prepares the AgentKit ${provider} provider's ${action} action as one unsigned transaction. The provider's own code runs against a wallet that records the transaction instead of sending it; the kit simulates it and runs the policy pre-flight, and nothing moves until execute hands it to your signer. An action that sends more than one transaction or signs a message is refused.`;
  const cleaned = own.replace(/\s+/g, " ").trim();
  const full = cleaned ? `${lead} The provider describes it as: ${cleaned}` : lead;
  const issues = lintDescription(full);
  if (issues.length === 0) return { text: full, note: null };
  return { text: lead, note: `the provider's description was left out: ${issues.map((i) => i.rule).join(", ")}` };
}

const PREPARE_OUTPUT: JsonSchemaObject = {
  type: "object",
  description: "A PreparedIntent (sato.action/v1 intent shape).",
  properties: {
    intent_id: { type: "string", pattern: "^si_[A-Za-z0-9_-]{43}$" },
    action: { type: "string" },
    expires_at: { type: "string" },
    summary: { type: "string" },
    policy: { type: "object" },
    simulation: { description: "SimulationResult, or null when the policy refused first." },
    fee_disclosure: { description: "Always null: the kit adds no fee to a consumed action." },
    unsigned: { type: "object", description: "UnsignedEvmTx: the one transaction the provider tried to send." },
  },
  required: ["intent_id", "action", "expires_at", "summary", "policy", "simulation", "fee_disclosure", "unsigned"],
} as JsonSchemaObject;

const READ_OUTPUT: JsonSchemaObject = {
  type: "object",
  properties: {
    provider: { type: "string" },
    action: { type: "string" },
    output: { type: "string", description: "The provider's own text output, unchanged." },
  },
  required: ["provider", "action", "output"],
} as JsonSchemaObject;

// ── running an action against the capturing wallet ────────────────────────────

type Source = { provider: ActionProvider<WalletProvider>; fullName: string; schema: unknown };

async function runCaptured(src: Source, input: unknown, ctx: ActionContext, chain: EvmChain, network: Network, from: `0x${string}` | undefined) {
  const parsed = (src.schema as { safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: { message?: string } } }).safeParse?.(input ?? {});
  if (parsed && !parsed.success) throw new ActionInputError(`${src.fullName}: ${parsed.error?.message ?? "invalid input"}`);
  const args = parsed ? parsed.data : input;
  const address = from ?? (ctx.signer ? await ctx.signer.address(chain) : undefined);
  if (!address) throw new ActionInputError(`${src.fullName}: no sender; configure a signer or pass { from }`);
  const wallet = new CapturingWalletProvider(address, network, () => ctx.rpc(chain));
  const action = src.provider.getActions(wallet).find((a: Action) => a.name === src.fullName);
  if (!action) throw new Error(`${src.fullName}: the provider no longer exposes this action`);
  let output: string;
  let thrown: unknown = null;
  try {
    output = String(await action.invoke(args as any));
  } catch (e) {
    thrown = e;
    output = e instanceof Error ? e.message : String(e);
  }
  return { args, address, wallet, output, thrown };
}

// ── the entry point ────────────────────────────────────────────────────────────

/**
 * Turn each action of an AgentKit ActionProvider into kit actions. Pure apart
 * from calling the provider's getActions(); nothing is sent while consuming.
 */
export function fromAgentKitProvider(provider: ActionProvider<WalletProvider>, opts: FromAgentKitOptions): FromAgentKitResult {
  const chain = opts.chain;
  if (!(chain in EVM_CHAIN_IDS)) throw new ActionInputError(`fromAgentKitProvider: chain ${String(chain)} is not an EVM chain the kit supports`);
  const chain_id = EVM_CHAIN_IDS[chain];
  const network: Network = { protocolFamily: "evm", networkId: AGENTKIT_NETWORK_IDS[chain], chainId: String(chain_id) };
  const providerName = String((provider as { name?: unknown }).name ?? provider.constructor.name);
  const providerClass = provider.constructor.name;
  const result: FromAgentKitResult = { actions: [], consumed: [], not_consumable: [] };

  if (!provider.supportsNetwork(network)) {
    result.not_consumable.push({ action: providerName, reason: `the provider does not support ${network.networkId}` });
    return result;
  }

  const probe = new CapturingWalletProvider(opts.from ?? "0x0000000000000000000000000000000000000000", network, () => {
    throw new Error("no rpc while listing actions");
  });
  const reads = new Set(opts.reads ?? []);
  const prefix = opts.idPrefix ?? "agentkit";

  for (const a of provider.getActions(probe)) {
    const short = shortName(providerClass, a.name);
    const id = `${segment(prefix)}.${segment(providerName)}.${segment(short)}`;
    let name: string;
    try {
      name = odaIdToToolName(id);
    } catch (e) {
      result.not_consumable.push({ action: a.name, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const conv = agentKitSchemaToPortable(a.schema);
    if (!conv.ok) {
      result.not_consumable.push({ action: a.name, reason: conv.reason });
      continue;
    }
    const kind: "read" | "prepare" = reads.has(short) || (opts.reads === undefined && READ_NAME.test(short)) ? "read" : "prepare";
    const desc = describeText(providerName, short, kind, a.description ?? "");
    const src: Source = { provider, fullName: a.name, schema: a.schema };
    const descriptor: ActionDescriptor = {
      schema: ACTION_SCHEMA_ID,
      id,
      name,
      version: "0.1.0",
      title: `AgentKit ${providerName}: ${short}`,
      description: desc.text,
      effects: kind === "read" ? ["read"] : ["simulate", "sign", "broadcast"],
      custody: { reads_key: false, sends_key: false, moves_funds: kind === "read" ? "never" : "with_approval" },
      chains: [chain],
      input_schema: conv.schema,
      output_schema: kind === "read" ? READ_OUTPUT : PREPARE_OUTPUT,
      policy: {
        rules: kind === "read" ? [] : [
          "network_mainnet_not_enabled", "chain_allowlist", "token_allowlist", "contract_allowlist", "recipient_allowlist",
          "max_per_trade", "max_usd_per_trade", "max_usd_per_day", "unknown_price", "intent_ttl",
          "simulation_required", "simulation_failed",
        ],
      },
      receipt: kind === "prepare",
      fixtures: [],
      upstream: { ...AGENTKIT_PIN },
      sponsored: null,
    };
    result.consumed.push({ agentkit_name: a.name, id, kind, tightened: conv.tightened, description_note: desc.note });

    if (kind === "read") {
      const read: ReadAction = {
        descriptor,
        async run(input, ctx) {
          const r = await runCaptured(src, input, ctx, chain, network, opts.from);
          if (r.wallet.captured.txs.length || r.wallet.captured.signs.length) {
            throw new AgentKitCaptureRefused(`${id}: classified as a read but tried to ${r.wallet.captured.txs.length ? "send a transaction" : `sign (${r.wallet.captured.signs.join(", ")})`}; nothing was sent`, r.wallet.captured);
          }
          if (r.thrown) throw r.thrown;
          return { provider: providerName, action: short, output: r.output };
        },
      };
      result.actions.push(read);
      continue;
    }

    const prep: PrepareAction = {
      descriptor,
      async build(input, ctx): Promise<PrepareBuild> {
        const r = await runCaptured(src, input, ctx, chain, network, opts.from);
        const cap = r.wallet.captured;
        if (cap.signs.length) {
          throw new AgentKitCaptureRefused(`${id}: refused — the action tried to sign (${cap.signs.join(", ")}); the kit consumes actions that send exactly one transaction. Nothing was signed or sent.`, cap);
        }
        if (cap.txs.length > 1) {
          throw new AgentKitCaptureRefused(`${id}: refused — the action tried to send ${cap.txs.length} transactions; one intent is one transaction. Nothing was sent.`, cap);
        }
        if (cap.txs.length === 0) {
          throw new AgentKitCaptureRefused(`${id}: the action sent no transaction. The provider said: ${r.output}`, cap);
        }
        const tx = cap.txs[0]!;
        if (typeof tx.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) {
          throw new AgentKitCaptureRefused(`${id}: refused — the captured transaction has no recipient address (a deployment is not consumed). Nothing was sent.`, cap);
        }
        const unsigned: UnsignedEvmTx = {
          kind: "evm_tx", chain, chain_id, from: r.address, to: tx.to,
          data: typeof tx.data === "string" && tx.data.length ? tx.data : "0x",
          value: toBig(tx.value).toString(),
        };
        const f = factsFromTx(chain, unsigned);
        return {
          params: { provider: providerName, action: short, args: r.args, captured_txs: 1, usd_value: null },
          unsigned,
          facts: { action: id, chain, network: ctx.policy.network, ...f, usd_value: null, usd_spent_today: null },
          summary: `AgentKit ${providerName}.${short} on ${chain}: one transaction to ${unsigned.to}, value ${unsigned.value} wei, calldata ${unsigned.data.slice(0, 10)}${f.token ? `; moves ${f.token_amount_base_units} base units of ${f.token}` : ""}${f.recipient ? ` to ${f.recipient}` : ""}. Captured from the provider's own code; nothing was sent. USD value: unknown.`,
          fee_disclosure: null,
        };
      },
    };
    result.actions.push(prep);
  }
  return result;
}
