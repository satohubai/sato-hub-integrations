// INTENT builder. prepare -> execute; execute takes only { intent_id }.
//
// prepare does the thinking (build, simulate, pre-flight, fee disclosure) and
// returns an opaque intent_id bound by HMAC to the exact parameters and
// payload. execute takes that id and nothing else, so nothing can change
// between approval and signature.
//
// The policy here is a PRE-FLIGHT: it explains refusals before anything is
// signed. ENFORCEMENT lives in the signer (and its native policy, when it has
// one) — a kit refusal is not a substitute for a signer that enforces.
//
// Secret: pass `secret` (or `intentSecret`), e.g. from loadOrCreateIntentSecret.
// Without one the kit uses a random per-process secret, and prepared intents
// then do not survive a restart.
import { approvalHints, canonicalJson, parseExecuteRequest } from "./spec/index.js";
import type {
  ActionDescriptor,
  OdaEffect,
  PreparedIntent,
  Receipt,
  ReceiptStatus,
  Refusal,
  SimulationResult,
  UnsignedEvmTx,
} from "./spec/index.js";
import type {
  ActionContext,
  AnyAction,
  CreateKitOptions,
  EvaluatePreflight,
  IntentRecord,
  IntentStore,
  Kit,
  PrepareAction,
  ReadAction,
  ReceiptLog,
} from "./types.js";
import { evaluatePreflight } from "./policy/preflight.js";
import { simulateTx } from "./actions/tx_simulate.js";
import { ActionRefusedError } from "./actions/_util.js";
import { computeIntentId, newNonce, paramsDigest, randomIntentSecret, verifyIntentId } from "./intent/hmac.js";
import { memoryIntentStore } from "./intent/store.js";
import { memoryReceiptLog } from "./receipts/log.js";
import { KIT_USER_AGENT } from "./version.js";

/** simulateTx(unsigned, ctx) as exported by actions/tx_simulate.ts. */
export type SimulateTx = (unsigned: UnsignedEvmTx, ctx: ActionContext) => Promise<SimulationResult>;

/**
 * CreateKitOptions plus the names the build scope uses. `secret` is optional
 * here (random per process when absent); `intentSecret`, `intentStore` and
 * `receiptLog` are aliases for `secret`, `intents` and `receipts`.
 * `simulate` / `evaluate` are injection seams for tests and alternative engines.
 */
export type KitOptions = Omit<CreateKitOptions, "secret"> & {
  secret?: Uint8Array;
  intentSecret?: Uint8Array;
  intentStore?: IntentStore;
  receiptLog?: ReceiptLog;
  simulate?: SimulateTx;
  evaluate?: EvaluatePreflight;
};

const PASSIVE: readonly OdaEffect[] = ["read", "quote", "simulate"];

function isReadAction(a: AnyAction): a is ReadAction {
  return typeof (a as ReadAction).run === "function";
}
function isPrepareAction(a: AnyAction): a is PrepareAction {
  return typeof (a as PrepareAction).build === "function";
}

/** The rules that only make sense for an EVM transaction (an x402 payment has nothing to simulate). */
const EVM_ONLY_RULES: ReadonlySet<Refusal["rule"]> = new Set(["simulation_required", "simulation_failed"]);

function refusal(rule: Refusal["rule"], limit: string, observed: string, message: string): Refusal {
  return { rule, limit, observed, message };
}

export function createKit(opts: KitOptions): Kit {
  const secret = opts.secret ?? opts.intentSecret ?? randomIntentSecret();
  const store = opts.intents ?? opts.intentStore ?? memoryIntentStore();
  const receipts = opts.receipts ?? opts.receiptLog ?? memoryReceiptLog();
  const clock = opts.clock ?? (() => Date.now());
  const evaluate = opts.evaluate ?? evaluatePreflight;
  const policy = opts.policy;
  const policyDigest = paramsDigest(policy);
  const actions = new Map<string, AnyAction>();
  for (const a of opts.actions ?? []) {
    if (actions.has(a.descriptor.id)) throw new Error(`duplicate action id "${a.descriptor.id}"`);
    actions.set(a.descriptor.id, a);
  }

  const ctx: ActionContext = {
    fetch: opts.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)),
    clock,
    rpc: opts.rpc,
    signer: opts.signer,
    policy,
    userAgent: opts.userAgent ?? KIT_USER_AGENT,
    fixtures: opts.fixtures,
  };

  const iso = (ms: number) => new Date(ms).toISOString();

  function lookup(id: string): AnyAction {
    const a = actions.get(id);
    if (!a) throw new Error(`unknown action "${id}"`);
    return a;
  }

  function chainOf(r: IntentRecord): string {
    return r.unsigned.kind === "evm_tx" ? r.unsigned.chain : r.unsigned.network;
  }

  function writeReceipt(r: IntentRecord, status: ReceiptStatus, tx_hash: string | null, approval: "human" | "policy" | "none"): Promise<Receipt> {
    const i = r.intent;
    return receipts.append({
      intent_id: i.intent_id,
      action: i.action,
      chain: chainOf(r),
      params_digest: r.params_digest,
      policy: i.policy,
      simulation: i.simulation,
      fee_disclosure: i.fee_disclosure,
      tx_hash,
      status,
      created_at: iso(clock()),
      mandate: { kind: "intent", intent_id: i.intent_id, action: i.action, policy_digest: policyDigest, expires_at: i.expires_at, approval },
    });
  }

  /**
   * USD executed in the current UTC day, from the receipt log. The frozen
   * sato.receipt/v1 has no USD field, so each intent's usd_value is kept as a
   * SIDECAR in the intent store (bound into params_digest at prepare) and read
   * back here by intent_id. An executed receipt today whose USD value is not
   * known makes the total unknown (null) — never a guessed zero.
   */
  async function usdSpentToday(): Promise<number | null> {
    const day = iso(clock()).slice(0, 10);
    let total = 0;
    for (const r of await receipts.read()) {
      if (r.status !== "executed" || r.created_at.slice(0, 10) !== day) continue;
      const rec = await store.get(r.intent_id);
      const usd = (rec?.params as { usd_value?: unknown } | undefined)?.usd_value;
      if (typeof usd !== "number" || !Number.isFinite(usd)) return null;
      total += usd;
    }
    return total;
  }

  function refusalList(refusals: readonly Refusal[]): string {
    return refusals.map((x) => `${x.rule} (limit ${x.limit}, observed ${x.observed})`).join("; ");
  }

  return {
    receipts,

    async read<O = unknown>(id: string, input: unknown): Promise<O> {
      const a = lookup(id);
      const effects = a.descriptor.effects;
      if (!isReadAction(a) || effects.length === 0 || !effects.every((e) => PASSIVE.includes(e))) {
        throw new Error(`action "${id}" is not read-only (effects: ${effects.join(", ") || "none"}); use prepare`);
      }
      return (await a.run(input, ctx)) as O;
    },

    async prepare(id: string, input: unknown): Promise<PreparedIntent> {
      const a = lookup(id);
      if (!isPrepareAction(a)) throw new Error(`action "${id}" has no prepare step; use read`);
      let built;
      try {
        built = await a.build(input, ctx);
      } catch (e) {
        // A build that found nothing it may build names its rules; keep them on the error.
        if (e instanceof ActionRefusedError) {
          throw Object.assign(new Error(`action "${id}" refused before an intent was built: ${refusalList(e.refusals)}`), { refusals: e.refusals });
        }
        throw e;
      }

      // Simulate FIRST, then the pre-flight sees the result.
      let simulation: SimulationResult | null = null;
      let simError: string | null = null;
      if (built.unsigned.kind === "evm_tx") {
        const simulate: SimulateTx | undefined = opts.simulate ?? simulateTx;
        if (simulate) {
          try {
            simulation = await simulate(built.unsigned, ctx);
          } catch (e) {
            simError = e instanceof Error ? e.message : String(e);
          }
        } else {
          simError = "no simulator available";
        }
      }

      const ttl_s = policy.intent_ttl_s;
      const usd_spent_today = await usdSpentToday();
      const verdict = evaluate(policy, { ...built.facts, usd_spent_today, simulation, ttl_s });
      // simulation_required applies to EVM transactions; an x402 payment is a signed
      // authorization with no transaction to simulate, so those rules do not apply.
      const refusals = built.unsigned.kind === "evm_tx"
        ? [...verdict.refusals]
        : verdict.refusals.filter((x) => !EVM_ONLY_RULES.has(x.rule));
      // require_simulation is constant: an EVM tx never leaves prepare unsimulated,
      // whatever the evaluator returned.
      if (built.unsigned.kind === "evm_tx") {
        if (!simulation && !refusals.some((r) => r.rule === "simulation_required")) {
          refusals.push(refusal("simulation_required", "simulated", "not simulated", `The transaction was not simulated${simError ? `: ${simError}` : ""}.`));
        } else if (simulation && !simulation.ok && !refusals.some((r) => r.rule === "simulation_failed")) {
          refusals.push(refusal("simulation_failed", "ok", simulation.error ?? "unknown", `Simulation failed: ${simulation.error ?? "unknown"}.`));
        }
      }
      const ok = refusals.length === 0;

      // Bind the params AND the payload execute will hand the signer.
      // usd_value rides along as the receipt sidecar read by usdSpentToday().
      const bound = { params: built.params, unsigned: built.unsigned, usd_value: built.facts.usd_value };
      const params_digest = paramsDigest(bound);
      const expires_at_ms = clock() + ttl_s * 1000;
      const expires_at = iso(expires_at_ms);
      const nonce = newNonce();
      const intent_id = computeIntentId(secret, { action: id, params_digest, expires_at, nonce });

      const intent: PreparedIntent = {
        intent_id,
        action: id,
        expires_at,
        summary: built.summary,
        policy: { ok, refusals },
        simulation,
        fee_disclosure: built.fee_disclosure,
        unsigned: built.unsigned,
      };
      const record: IntentRecord = { intent, params: bound, params_digest, unsigned: built.unsigned, nonce, expires_at_ms };
      await store.put(record);
      await writeReceipt(record, ok ? "prepared" : "refused", null, "none");
      return intent;
    },

    async execute(req) {
      const parsed = parseExecuteRequest(req);
      if (!parsed.ok) throw new Error(parsed.error);
      const id = parsed.request.intent_id;

      const record = await store.get(id);
      if (!record) throw new Error(`unknown intent_id ${id}`);

      // Re-verify the MAC over what is stored: a changed param or payload fails here.
      const digest = paramsDigest(record.params);
      const sameDigest = digest === record.params_digest;
      const sameUnsigned = canonicalJson(record.unsigned) === canonicalJson((record.params as { unsigned?: unknown })?.unsigned ?? null)
        && canonicalJson(record.unsigned) === canonicalJson(record.intent.unsigned);
      const macOk = verifyIntentId(secret, id, { action: record.intent.action, params_digest: digest, expires_at: record.intent.expires_at, nonce: record.nonce });
      if (!sameDigest || !sameUnsigned || !macOk || record.intent.intent_id !== id) {
        throw new Error(`intent ${id} failed its integrity check (HMAC mismatch); prepare a new intent`);
      }

      if (clock() >= record.expires_at_ms) {
        await writeReceipt(record, "expired", null, "none");
        throw new Error(`intent ${id} expired at ${record.intent.expires_at}; prepare a new intent`);
      }
      if (!record.intent.policy.ok) {
        // The refusals ride on the error so every door (CLI, MCP, adapters) can name rule, limit and observed.
        throw Object.assign(new Error(`intent ${id} was refused by the policy pre-flight: ${refusalList(record.intent.policy.refusals)}`), {
          refusals: [...record.intent.policy.refusals],
        });
      }
      if (!opts.signer) throw new Error("no signer configured; execute needs a signer");
      if (record.unsigned.kind !== "evm_tx") {
        throw new Error(`intent ${id} is an ${record.unsigned.kind}; execute sends EVM transactions only`);
      }

      const once = await store.consume(id);
      if (!once) throw new Error(`intent ${id} already executed`);

      const approval = opts.signer.kind === "human-approve" ? "human" : "policy";
      let tx_hash: string;
      try {
        ({ tx_hash } = await opts.signer.sendTransaction(once.unsigned as UnsignedEvmTx));
      } catch (e) {
        await writeReceipt(once, "failed", null, approval);
        throw e;
      }
      return writeReceipt(once, "executed", tx_hash, approval);
    },

    describe(id: string): ActionDescriptor {
      const d = lookup(id).descriptor;
      return { ...d, approval_hints: approvalHints(d.effects) } as ActionDescriptor;
    },

    search(q: string): ActionDescriptor[] {
      const needle = q.trim().toLowerCase();
      return [...actions.values()]
        .map((a) => a.descriptor)
        .filter((d) => !needle || d.id.toLowerCase().includes(needle) || d.title.toLowerCase().includes(needle));
    },
  };
}

