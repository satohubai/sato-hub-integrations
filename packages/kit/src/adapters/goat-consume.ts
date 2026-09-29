// ADAPTERS — the migration window (scope §16.2 #4, K2): consume an existing
// GOAT SDK plugin (@goat-sdk/core PluginBase) as kit actions, with the same
// guarantees as fromAgentKitProvider.
//
//   const { actions, not_consumable } = await fromGoatPlugin(erc20({ tokens: [USDC] }), { chain: "base" });
//   const kit = createKit({ ...opts, actions: [...coreActions(), ...actions] });
//
// HOW A WRITE RUNS. The plugin's own tool runs against a CAPTURING wallet
// client: it has the GOAT EVMWalletClient surface (getAddress, getChain, read,
// balanceOf, sendTransaction, signMessage, signTypedData), reads go to the
// kit's RPC (ctx.rpc), and sendTransaction ENCODES and RECORDS the one
// transaction and returns a placeholder hash instead of sending. Nothing is
// signed or broadcast while the plugin runs. The captured transaction becomes
// the intent's UnsignedEvmTx: simulate -> pre-flight -> execute(intent_id)
// with the kit's signer, once.
//
// REFUSED, with the reason, and never partially executed (nothing was sent):
//   - more than one transaction (one intent is one transaction);
//   - a message or typed-data signature;
//   - no transaction (the plugin's own output or error is passed through);
//   - a transaction with no `to`, or one asking for a paymaster (the kit's
//     signer would send it without the sponsorship the plugin expected).
//
// READS. A tool classified as a read (opts.reads, or a get_/check_/list_/
// convert_… name) becomes a ReadAction on the same capturing wallet; a "read"
// that tries to send or sign is refused, so a wrong classification cannot
// move funds.
//
// SCHEMAS. Each tool's zod schema is turned into a JSON Schema and put through
// the portable-schema lint. GOAT plugins pass amount and address strings
// straight to the ABI, so an amount-named string with no pattern is narrowed
// to an integer (base units) and an address-named one to a hex address; both
// are listed in `tightened`. Anything still not portable is
// listed in `not_consumable` with the reason — it is not faked into a tool.
//
// NO RUNTIME IMPORT of @goat-sdk/*: the plugin brings its own core, the
// capturing wallet is structural, and nothing here makes a network call.
// GOAT injects the wallet only when the plugin and its wallet-evm share ONE
// @goat-sdk/core copy (it checks the parameter type with instanceof); with
// two copies installed, GOAT's own tool receives no wallet and throws — fix
// the install so one core is resolved. Upstream GOAT has had no release
// since 2025-05; the pin below is the version this adapter is tested
// against, not an endorsement of it.
//
// VENUE NEUTRALITY (§0.3): a consumed tool is not ranked, labelled or gated
// differently from a core action because of whose code it is.
import { encodeFunctionData, formatUnits } from "viem";
import type { Abi, PublicClient } from "viem";
import { ACTION_SCHEMA_ID, lintDescription, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, JsonSchemaObject, UnsignedEvmTx } from "../spec/index.js";
import type { ActionContext, AnyAction, PrepareAction, PrepareBuild, ReadAction } from "../types.js";
import { ActionInputError, EVM_CHAIN_IDS } from "../actions/_util.js";
import type { EvmChain } from "../actions/_util.js";
import { BASE_UNITS_PATTERN, EVM_ADDRESS_PATTERN, NATIVE_SYMBOL, factsFromTx, segment, toBig, zodToPortable } from "./_consume.js";

/** The @goat-sdk/core version this adapter is tested against (brought in by the @goat-sdk/plugin-erc20 devDependency). */
export const GOAT_PIN = { "@goat-sdk/core": "0.4.9" } as const;

/** The structural slice of a GOAT tool the adapter uses. */
export type GoatTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute(params: unknown): unknown;
};

/** The structural slice of a GOAT PluginBase the adapter uses. */
export type GoatPlugin = {
  name: string;
  supportsChain(chain: { type: "evm"; id: number }): boolean;
  getTools(wallet: any): GoatTool[] | Promise<GoatTool[]>;
};

export type FromGoatOptions = {
  /** The chain every consumed tool runs on. */
  chain: EvmChain;
  /** Sender used when the kit has no signer (prepare only; execute still needs a signer). */
  from?: `0x${string}`;
  /** GOAT tool names to treat as reads. Default: get_/check_/list_/convert_… names. */
  reads?: readonly string[];
  /** First id segment. Default "goat". */
  idPrefix?: string;
};

export type GoatNotConsumable = { tool: string; reason: string };

export type GoatConsumedTool = {
  goat_name: string;
  id: string;
  kind: "read" | "prepare";
  tightened: string[];
  description_note: string | null;
};

export type FromGoatResult = {
  actions: AnyAction[];
  consumed: GoatConsumedTool[];
  not_consumable: GoatNotConsumable[];
};

export type GoatCaptured = {
  txs: Array<{ to?: string; data?: string; value?: unknown }>;
  signs: string[];
  refused: string[];
};

export class GoatCaptureRefused extends Error {
  readonly captured: GoatCaptured;
  constructor(message: string, captured: GoatCaptured) {
    super(message);
    this.name = "GoatCaptureRefused";
    this.captured = captured;
  }
}

const READ_NAME = /^(get|check|list|fetch|read|query|search|lookup|convert)_/;

/**
 * A GOAT EVMWalletClient-shaped object that never sends or signs. Reads go to
 * the client; sendTransaction encodes, records and returns a placeholder hash;
 * sign methods record the attempt and throw.
 */
export class CapturingGoatWallet {
  readonly captured: GoatCaptured = { txs: [], signs: [], refused: [] };
  readonly #address: `0x${string}`;
  readonly #chain: EvmChain;
  readonly #client: () => PublicClient;

  constructor(address: `0x${string}`, chain: EvmChain, client: () => PublicClient) {
    this.#address = address;
    this.#chain = chain;
    this.#client = client;
  }
  getAddress(): string { return this.#address; }
  getChain(): { type: "evm"; id: number } { return { type: "evm", id: EVM_CHAIN_IDS[this.#chain] }; }
  getCoreTools(): GoatTool[] { return []; }
  async resolveAddress(address: string): Promise<`0x${string}`> {
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) return address as `0x${string}`;
    throw new Error(`sato-kit: ${address} is not a hex address; name resolution is not done by the capturing wallet`);
  }
  async balanceOf(address: string) {
    const v = await this.#client().getBalance({ address: address as `0x${string}` });
    const sym = NATIVE_SYMBOL[this.#chain];
    return { decimals: 18, symbol: sym, name: sym, value: formatUnits(v, 18), inBaseUnits: v.toString() };
  }
  async read(req: { address: string; functionName: string; args?: unknown[]; abi: Abi }): Promise<{ value: unknown }> {
    const value = await this.#client().readContract({ address: req.address as `0x${string}`, abi: req.abi, functionName: req.functionName, args: req.args ?? [] } as any);
    return { value };
  }
  async sendTransaction(tx: { to: string; functionName?: string; args?: unknown[]; value?: bigint; abi?: Abi; options?: { paymaster?: unknown }; data?: `0x${string}` }): Promise<{ hash: string }> {
    if (tx?.options?.paymaster) {
      this.captured.refused.push("paymaster");
      throw new Error("sato-kit: a paymaster transaction is not captured");
    }
    let data: string | undefined = tx?.data;
    if (!data && tx?.abi && tx.functionName) {
      data = encodeFunctionData({ abi: tx.abi, functionName: tx.functionName, args: tx.args ?? [] } as any);
    }
    this.captured.txs.push({ to: tx?.to, data, value: tx?.value });
    return { hash: `0x${this.captured.txs.length.toString(16).padStart(64, "0")}` };
  }
  #refuseSign(kind: string): never {
    this.captured.signs.push(kind);
    throw new Error(`sato-kit: ${kind} is not captured; the kit consumes tools that send one transaction`);
  }
  async signMessage(_m: string): Promise<{ signature: string }> { return this.#refuseSign("signMessage"); }
  async signTypedData(_t: unknown): Promise<{ signature: string }> { return this.#refuseSign("signTypedData"); }
}

// ── descriptors ────────────────────────────────────────────────────────────────

function describeText(plugin: string, tool: string, kind: "read" | "prepare", own: string): { text: string; note: string | null } {
  const lead = kind === "read"
    ? `Runs the GOAT ${plugin} plugin's ${tool} tool as a read. It runs against a wallet that cannot send or sign; an attempt to send or sign is refused.`
    : `Prepares the GOAT ${plugin} plugin's ${tool} tool as one unsigned transaction. The plugin's own code runs against a wallet that records the transaction instead of sending it; the kit simulates it and runs the policy pre-flight, and nothing moves until execute hands it to your signer. A tool that sends more than one transaction or signs a message is refused.`;
  const cleaned = own.replace(/\s+/g, " ").trim();
  const full = cleaned ? `${lead} The plugin describes it as: ${cleaned}` : lead;
  const issues = lintDescription(full);
  if (issues.length === 0) return { text: full, note: null };
  return { text: lead, note: `the plugin's description was left out: ${issues.map((i) => i.rule).join(", ")}` };
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
    fee_disclosure: { description: "Always null: the kit adds no fee to a consumed tool." },
    unsigned: { type: "object", description: "UnsignedEvmTx: the one transaction the plugin tried to send." },
  },
  required: ["intent_id", "action", "expires_at", "summary", "policy", "simulation", "fee_disclosure", "unsigned"],
} as JsonSchemaObject;

const READ_OUTPUT: JsonSchemaObject = {
  type: "object",
  properties: {
    plugin: { type: "string" },
    tool: { type: "string" },
    output: { type: "string", description: "The plugin's own output; JSON text when it returned a value that is not a string." },
  },
  required: ["plugin", "tool", "output"],
} as JsonSchemaObject;

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? String(v);
}

// ── running a tool against the capturing wallet ───────────────────────────────

async function runCaptured(plugin: GoatPlugin, toolName: string, schema: unknown, input: unknown, ctx: ActionContext, chain: EvmChain, from: `0x${string}` | undefined) {
  const parsed = (schema as { safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: { message?: string } } }).safeParse?.(input ?? {});
  if (parsed && !parsed.success) throw new ActionInputError(`${toolName}: ${parsed.error?.message ?? "invalid input"}`);
  const args = parsed ? parsed.data : input;
  const address = from ?? (ctx.signer ? await ctx.signer.address(chain) : undefined);
  if (!address) throw new ActionInputError(`${toolName}: no sender; configure a signer or pass { from }`);
  const wallet = new CapturingGoatWallet(address, chain, () => ctx.rpc(chain));
  const tool = (await plugin.getTools(wallet)).find((t) => t.name === toolName);
  if (!tool) throw new Error(`${toolName}: the plugin no longer exposes this tool`);
  let output: string;
  let thrown: unknown = null;
  try {
    output = stringify(await tool.execute(args));
  } catch (e) {
    thrown = e;
    output = e instanceof Error ? e.message : String(e);
  }
  return { args, address, wallet, output, thrown };
}

// ── the entry point ────────────────────────────────────────────────────────────

/**
 * Turn each tool of a GOAT plugin into kit actions. Calls only the plugin's
 * supportsChain() and getTools() on a capturing wallet; nothing is sent.
 */
export async function fromGoatPlugin(plugin: GoatPlugin, opts: FromGoatOptions): Promise<FromGoatResult> {
  const chain = opts.chain;
  if (!(chain in EVM_CHAIN_IDS)) throw new ActionInputError(`fromGoatPlugin: chain ${String(chain)} is not an EVM chain the kit supports`);
  const chain_id = EVM_CHAIN_IDS[chain];
  const pluginName = String(plugin.name ?? plugin.constructor?.name ?? "plugin");
  const result: FromGoatResult = { actions: [], consumed: [], not_consumable: [] };

  if (!plugin.supportsChain({ type: "evm", id: chain_id })) {
    result.not_consumable.push({ tool: pluginName, reason: `the plugin does not support evm chain ${chain_id} (${chain})` });
    return result;
  }

  const probe = new CapturingGoatWallet(opts.from ?? "0x0000000000000000000000000000000000000000", chain, () => {
    throw new Error("no rpc while listing tools");
  });
  const reads = new Set(opts.reads ?? []);
  const prefix = opts.idPrefix ?? "goat";

  for (const t of await plugin.getTools(probe)) {
    const id = `${segment(prefix)}.${segment(pluginName)}.${segment(t.name)}`;
    let name: string;
    try {
      name = odaIdToToolName(id);
    } catch (e) {
      result.not_consumable.push({ tool: t.name, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const conv = zodToPortable(t.parameters, BASE_UNITS_PATTERN, EVM_ADDRESS_PATTERN);
    if (!conv.ok) {
      result.not_consumable.push({ tool: t.name, reason: conv.reason });
      continue;
    }
    const kind: "read" | "prepare" = reads.has(t.name) || (opts.reads === undefined && READ_NAME.test(t.name)) ? "read" : "prepare";
    const desc = describeText(pluginName, t.name, kind, t.description ?? "");
    const toolName = t.name;
    const schema = t.parameters;
    const descriptor: ActionDescriptor = {
      schema: ACTION_SCHEMA_ID,
      id,
      name,
      version: "0.1.0",
      title: `GOAT ${pluginName}: ${toolName}`,
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
      upstream: { ...GOAT_PIN },
      sponsored: null,
    };
    result.consumed.push({ goat_name: toolName, id, kind, tightened: conv.tightened, description_note: desc.note });

    if (kind === "read") {
      const read: ReadAction = {
        descriptor,
        async run(input, ctx) {
          const r = await runCaptured(plugin, toolName, schema, input, ctx, chain, opts.from);
          const cap = r.wallet.captured;
          if (cap.txs.length || cap.signs.length || cap.refused.length) {
            throw new GoatCaptureRefused(`${id}: classified as a read but tried to ${cap.signs.length ? `sign (${cap.signs.join(", ")})` : "send a transaction"}; nothing was sent`, cap);
          }
          if (r.thrown) throw r.thrown;
          return { plugin: pluginName, tool: toolName, output: r.output };
        },
      };
      result.actions.push(read);
      continue;
    }

    const prep: PrepareAction = {
      descriptor,
      async build(input, ctx): Promise<PrepareBuild> {
        const r = await runCaptured(plugin, toolName, schema, input, ctx, chain, opts.from);
        const cap = r.wallet.captured;
        if (cap.signs.length) {
          throw new GoatCaptureRefused(`${id}: refused — the tool tried to sign (${cap.signs.join(", ")}); the kit consumes tools that send exactly one transaction. Nothing was signed or sent.`, cap);
        }
        if (cap.refused.length) {
          throw new GoatCaptureRefused(`${id}: refused — the tool asked for a ${cap.refused.join(", ")}; the kit's signer would send it without that sponsorship. Nothing was sent.`, cap);
        }
        if (cap.txs.length > 1) {
          throw new GoatCaptureRefused(`${id}: refused — the tool tried to send ${cap.txs.length} transactions; one intent is one transaction. Nothing was sent.`, cap);
        }
        if (cap.txs.length === 0) {
          throw new GoatCaptureRefused(`${id}: the tool sent no transaction. The plugin said: ${r.output}`, cap);
        }
        const tx = cap.txs[0]!;
        if (typeof tx.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) {
          throw new GoatCaptureRefused(`${id}: refused — the captured transaction has no recipient address. Nothing was sent.`, cap);
        }
        const unsigned: UnsignedEvmTx = {
          kind: "evm_tx", chain, chain_id, from: r.address, to: tx.to,
          data: typeof tx.data === "string" && tx.data.length ? tx.data : "0x",
          value: toBig(tx.value).toString(),
        };
        const f = factsFromTx(chain, unsigned);
        return {
          params: { plugin: pluginName, tool: toolName, args: r.args, captured_txs: 1, usd_value: null },
          unsigned,
          facts: { action: id, chain, network: ctx.policy.network, ...f, usd_value: null, usd_spent_today: null },
          summary: `GOAT ${pluginName}.${toolName} on ${chain}: one transaction to ${unsigned.to}, value ${unsigned.value} wei, calldata ${unsigned.data.slice(0, 10)}${f.token ? `; moves ${f.token_amount_base_units} base units of ${f.token}` : ""}${f.recipient ? ` to ${f.recipient}` : ""}. Captured from the plugin's own code; nothing was sent. USD value: unknown.`,
          fee_disclosure: null,
        };
      },
    };
    result.actions.push(prep);
  }
  return result;
}
