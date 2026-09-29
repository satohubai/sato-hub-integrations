/**
 * The shared seams of @satohub/kit. Every builder folder (policy, signers,
 * intent/receipts, actions) codes against these types; only the skeleton
 * owner edits this file.
 */
import type { PublicClient } from "viem";
import type {
  ActionDescriptor,
  ExecuteRequest,
  FeeDisclosure,
  OdaChain,
  PolicyNetwork,
  PreparedIntent,
  Receipt,
  Refusal,
  SatoPolicy,
  SimulationResult,
  UnsignedEvmTx,
  UnsignedPayload,
  UnsignedSolanaTx,
} from "./spec/index.js";

/** Wall clock in epoch milliseconds. Injected so tests are deterministic. */
export type Clock = () => number;

/** The fetch the kit uses for every HTTP call. Injected so tests replay fixtures. */
export type KitFetch = typeof fetch;

/** Returns a viem PublicClient for a chain. In fork mode it points at an anvil URL. */
export type RpcProvider = (chain: OdaChain) => PublicClient;

/** The two Solana clusters an UnsignedSolanaTx may name. */
export type SolanaCluster = UnsignedSolanaTx["chain"];

/**
 * The minimal Solana JSON-RPC seam the kit uses (simulateTransaction,
 * sendTransaction, getGenesisHash). `request` returns the JSON-RPC `result`
 * and throws on a JSON-RPC `error`. Injected so tests use a fake; see
 * `solanaJsonRpc(url)` for the fetch-backed implementation.
 */
export interface SolanaRpc {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}

/** Returns the Solana RPC for a cluster. Optional on the kit; additive in Phase 2 wave 2. */
export type SolanaRpcProvider = (chain: SolanaCluster) => SolanaRpc;

/** A Solana transaction after signing: the signed wire bytes (base64) and its base58 signature. */
export type SignedSolanaTx = { transaction_base64: string; signature: string };

/** EIP-712 typed data as handed to a signer. */
export type TypedDataInput = {
  domain: Record<string, unknown>;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

/** A policy expressed in a signer's own native format. This is where ENFORCEMENT lives. */
export type NativeSignerPolicy = {
  format: "cdp" | "ows" | "privy" | "turnkey" | "safe";
  document: unknown;
};

/**
 * Holds (or reaches) the key. The kit's policy is a pre-flight that explains
 * refusals; the signer (and its native policy, when present) is what enforces.
 */
export interface Signer {
  kind: "viem-local" | "ows" | "cdp" | "human-approve" | "solana-local";
  address(chain: OdaChain): Promise<`0x${string}`>;
  sendTransaction(tx: UnsignedEvmTx): Promise<{ tx_hash: `0x${string}` }>;
  signTypedData(td: TypedDataInput): Promise<`0x${string}`>;
  /**
   * OPTIONAL (Phase 2 wave 2). Signs a serialized unsigned Solana transaction
   * and returns it signed, without sending it. A signer without this (and
   * without sendSolanaTransaction) cannot execute a solana_tx intent.
   */
  signSolanaTransaction?(tx: UnsignedSolanaTx): Promise<SignedSolanaTx>;
  /** OPTIONAL (Phase 2 wave 2). Signs and sends a Solana transaction; returns its base58 signature. */
  sendSolanaTransaction?(tx: UnsignedSolanaTx): Promise<{ signature: string }>;
  nativePolicy?: NativeSignerPolicy;
}

/** The facts an action hands the pre-flight evaluator. */
export type PreflightFacts = {
  /** ODA id of the action. */
  action: string;
  chain: OdaChain;
  network: PolicyNetwork;
  /** Token symbol or address, as policy lists name it. */
  token?: string;
  /** Base units as a decimal string. */
  token_amount_base_units?: string;
  /** USD value of this trade; null = price unknown (rule unknown_price). */
  usd_value: number | null;
  /** USD already spent in the current UTC day; null = unknown. */
  usd_spent_today: number | null;
  contract?: string;
  recipient?: string;
  /** Address granted (or losing) an allowance or operator approval. Informational: no rule reads it. */
  spender?: string;
  venue?: string;
  slippage_bps?: number;
  /** null = not simulated (rule simulation_required). */
  simulation: SimulationResult | null;
  /** Requested intent lifetime in seconds. */
  ttl_s: number;
};

export type PreflightResult = { ok: boolean; refusals: Refusal[] };

/** Pure: same policy + facts -> same result. Implemented in src/policy/preflight.ts. */
export type EvaluatePreflight = (policy: SatoPolicy, facts: PreflightFacts) => PreflightResult;

/** What the intent store keeps per prepared intent. `intent_id` is the secret-bound HMAC id. */
export type IntentRecord = {
  intent: PreparedIntent;
  /** The action's params, exactly as digested into params_digest. */
  params: unknown;
  params_digest: string;
  unsigned: UnsignedPayload;
  nonce: string;
  /** Epoch ms. */
  expires_at_ms: number;
};

export interface IntentStore {
  put(record: IntentRecord): Promise<void>;
  get(intent_id: string): Promise<IntentRecord | null>;
  /** Atomic once: returns the record the first time, null on every later call. */
  consume(intent_id: string): Promise<IntentRecord | null>;
}

/** Receipt fields the log fills itself: schema, seq, prev_hash, hash. */
export type ReceiptDraft = Omit<Receipt, "schema" | "seq" | "prev_hash" | "hash">;

export interface ReceiptLog {
  append(draft: ReceiptDraft): Promise<Receipt>;
  read(): Promise<Receipt[]>;
  /** broken_at = seq of the first broken link, or null when the chain holds. */
  verify(): Promise<{ ok: boolean; broken_at: number | null }>;
}

/** Recorded responses for offline runs, keyed by the action's own fixture names. */
export type FixtureSource = {
  get(key: string): unknown | undefined;
};

export type ActionContext = {
  fetch: KitFetch;
  clock: Clock;
  rpc: RpcProvider;
  /** OPTIONAL (Phase 2 wave 2): Solana JSON-RPC, used to simulate and send solana_tx payloads. */
  solanaRpc?: SolanaRpcProvider;
  signer?: Signer;
  policy: SatoPolicy;
  userAgent: string;
  fixtures?: FixtureSource;
};

export type ReadAction<I = unknown, O = unknown> = {
  descriptor: ActionDescriptor;
  run(input: I, ctx: ActionContext): Promise<O>;
};

export type PrepareBuild = {
  params: unknown;
  unsigned: UnsignedPayload;
  facts: Omit<PreflightFacts, "simulation" | "ttl_s">;
  summary: string;
  fee_disclosure: FeeDisclosure | null;
};

export type PrepareAction<I = unknown> = {
  descriptor: ActionDescriptor;
  build(input: I, ctx: ActionContext): Promise<PrepareBuild>;
};

export type AnyAction = ReadAction<any, any> | PrepareAction<any>;

export type CreateKitOptions = {
  policy: SatoPolicy;
  /** HMAC secret binding intent ids. */
  secret: Uint8Array;
  signer?: Signer;
  rpc: RpcProvider;
  /** OPTIONAL (Phase 2 wave 2): Solana JSON-RPC for solana_tx simulation and sending. */
  solanaRpc?: SolanaRpcProvider;
  fetch?: KitFetch;
  clock?: Clock;
  actions?: readonly AnyAction[];
  intents?: IntentStore;
  receipts?: ReceiptLog;
  fixtures?: FixtureSource;
  userAgent?: string;
};

export type Kit = {
  read<O = unknown>(id: string, input: unknown): Promise<O>;
  prepare(id: string, input: unknown): Promise<PreparedIntent>;
  execute(req: ExecuteRequest): Promise<Receipt>;
  describe(id: string): ActionDescriptor;
  search(q: string): ActionDescriptor[];
  receipts: ReceiptLog;
};
