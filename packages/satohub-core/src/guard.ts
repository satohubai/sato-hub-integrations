/**
 * `withSatoCheck(fetch)` — an x402-aware fetch wrapper, plus a local record of
 * every payment attempt.
 *
 * FIRST CONTACT ONLY. When a payee host answers 402 and has not been checked in
 * the last 24 h, the wrapper asks Sato Check about that URL before the 402
 * reaches your payment logic. It never checks per micropayment.
 *
 * FAIL-OPEN BY DEFAULT. A check that cannot be read is a warning (`onWarning`),
 * never a refusal. `mode: "enforce"` refuses in exactly two cases: the check
 * reports a planted test key observed leaving (`key_egress: "observed"`), or
 * the endpoint answered 402 without readable payment terms.
 *
 * PAYMENT-ATTEMPT RECORD. A request carrying an x402 payment header gets a
 * record keyed by sha256(method + url + body digest + payTo + amount):
 * pending → settled | failed | unknown. If the response is lost (network error,
 * timeout, or an answer that does not say), the attempt stays `unknown` and a
 * second paid request with the same key is refused with AttemptUnresolvedError
 * until you call `resolveAttempt(key, state)`. The record is LOCAL — nothing
 * about a payment is sent to Sato Hub.
 */

import type { FetchLike } from "./client.js";
import { SatoHubClient } from "./client.js";

export type AttemptState = "pending" | "settled" | "failed" | "unknown";

export type PaymentAttempt = {
  key: string;
  state: AttemptState;
  method: string;
  url: string;
  pay_to: string | null;
  amount: string | null;
  created_at: string;
  updated_at: string;
};

export interface AttemptStore {
  get(key: string): Promise<PaymentAttempt | undefined>;
  put(attempt: PaymentAttempt): Promise<void>;
}

export class MemoryAttemptStore implements AttemptStore {
  private readonly map = new Map<string, PaymentAttempt>();
  async get(key: string) {
    return this.map.get(key);
  }
  async put(a: PaymentAttempt) {
    this.map.set(a.key, { ...a });
  }
}

/** A durable store: one JSON file, rewritten on every put. Node only. */
export class JsonFileAttemptStore implements AttemptStore {
  constructor(private readonly path: string) {}
  private async read(): Promise<Record<string, PaymentAttempt>> {
    const fs = await import("node:fs/promises");
    try {
      return JSON.parse(await fs.readFile(this.path, "utf8")) as Record<string, PaymentAttempt>;
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return {};
      throw e;
    }
  }
  async get(key: string) {
    return (await this.read())[key];
  }
  async put(a: PaymentAttempt) {
    const fs = await import("node:fs/promises");
    const all = await this.read();
    all[a.key] = a;
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2));
    await fs.rename(tmp, this.path);
  }
}

export class AttemptUnresolvedError extends Error {
  constructor(public readonly key: string, public readonly state: AttemptState) {
    super(
      `A payment attempt with the same request, payee and amount is ${state}. ` +
        `Check whether it settled, then call resolveAttempt("${key}", "settled" | "failed").`,
    );
    this.name = "AttemptUnresolvedError";
  }
}

export class SatoCheckRefusedError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`Sato Check (enforce mode) refused ${url}: ${reason}`);
    this.name = "SatoCheckRefusedError";
  }
}

export type WithSatoCheckOptions = {
  /** Client used for checkTarget. Default: a new SatoHubClient. */
  client?: Pick<SatoHubClient, "checkTarget">;
  /** "warn" (default, fail-open) or "enforce" (fail-closed on the two facts above). */
  mode?: "warn" | "enforce";
  onWarning?: (message: string) => void;
  attempts?: AttemptStore;
  /** How long a checked payee host is remembered. Default 24 h. */
  cacheTtlMs?: number;
  now?: () => number;
};

export type SatoCheckedFetch = FetchLike & {
  resolveAttempt(key: string, state: "settled" | "failed"): Promise<void>;
  attemptKey(input: { method: string; url: string; body?: string | null; payTo?: string | null; amount?: string | null }): Promise<string>;
};

const PAYMENT_HEADERS = ["x-payment", "payment-signature"];
const DAY_MS = 24 * 60 * 60 * 1000;

type Terms = { payTo: string | null; amount: string | null };

async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function bodyText(init?: RequestInit): string {
  const b = init?.body;
  return typeof b === "string" ? b : b == null ? "" : "[non-string body]";
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers;
  if (!h) return null;
  if (h instanceof Headers) return h.get(name);
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v as string;
  return null;
}

/** Reads payTo + amount from a 402: the JSON body's `accepts[0]`, or the v2 PAYMENT-REQUIRED header (base64 JSON). */
export async function readPaymentTerms(res: Response): Promise<Terms | null> {
  const pick = (o: unknown): Terms | null => {
    const a = (o as { accepts?: Array<Record<string, unknown>> } | null)?.accepts?.[0];
    if (!a) return null;
    const amount = a.maxAmountRequired ?? a.amount ?? null;
    return { payTo: typeof a.payTo === "string" ? a.payTo : null, amount: amount == null ? null : String(amount) };
  };
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      const t = pick(JSON.parse(atob(header)));
      if (t) return t;
    } catch {
      /* fall through to the body */
    }
  }
  try {
    return pick(await res.clone().json());
  } catch {
    return null;
  }
}

export function withSatoCheck(fetchImpl: FetchLike, opts: WithSatoCheckOptions = {}): SatoCheckedFetch {
  const mode = opts.mode ?? "warn";
  const warn = opts.onWarning ?? ((m: string) => console.warn(`[sato-check] ${m}`));
  const store = opts.attempts ?? new MemoryAttemptStore();
  const ttl = opts.cacheTtlMs ?? DAY_MS;
  const now = opts.now ?? Date.now;
  let client = opts.client;
  const checkedHosts = new Map<string, number>();
  const termsByUrl = new Map<string, Terms>();

  const attemptKey: SatoCheckedFetch["attemptKey"] = async ({ method, url, body, payTo, amount }) =>
    sha256Hex([method.toUpperCase(), url, await sha256Hex(body ?? ""), payTo ?? "", amount ?? ""].join("\n"));

  async function firstContact(url: string, res: Response): Promise<void> {
    const terms = await readPaymentTerms(res);
    if (terms) termsByUrl.set(url, terms);
    else if (mode === "enforce") throw new SatoCheckRefusedError(url, "the endpoint answered 402 without readable payment terms.");

    const host = new URL(url).host.toLowerCase();
    const seen = checkedHosts.get(host);
    if (seen !== undefined && now() - seen < ttl) return;
    try {
      client ??= new SatoHubClient();
      const { data } = await client.checkTarget(url, "x402");
      checkedHosts.set(host, now());
      if (data?.summary?.key_egress === "observed") {
        const msg = `a planted test key was observed leaving (${data.profile?.key_egress_hosts?.join(", ") || "host not named"}). ${data.check_url}`;
        if (mode === "enforce") throw new SatoCheckRefusedError(url, msg);
        warn(`${host}: ${msg}`);
      }
    } catch (e) {
      if (e instanceof SatoCheckRefusedError) throw e;
      warn(`could not read Sato Check for ${host}; continuing (${(e as Error).message}).`);
    }
  }

  const wrapped = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const paid = PAYMENT_HEADERS.some((h) => headerValue(init, h));

    if (!paid) {
      const res = await fetchImpl(url, init);
      if (res.status === 402) await firstContact(url, res);
      return res;
    }

    const terms = termsByUrl.get(url) ?? { payTo: null, amount: null };
    const key = await attemptKey({ method, url, body: bodyText(init), payTo: terms.payTo, amount: terms.amount });
    const prior = await store.get(key);
    if (prior && (prior.state === "unknown" || prior.state === "pending")) throw new AttemptUnresolvedError(key, prior.state);

    const stamp = new Date(now()).toISOString();
    const attempt: PaymentAttempt = {
      key, state: "pending", method, url, pay_to: terms.payTo, amount: terms.amount,
      created_at: prior?.created_at ?? stamp, updated_at: stamp,
    };
    await store.put(attempt);
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      await store.put({ ...attempt, state: "unknown", updated_at: new Date(now()).toISOString() });
      throw e;
    }
    const state: AttemptState = res.ok ? "settled" : res.status === 402 ? "failed" : "unknown";
    await store.put({ ...attempt, state, updated_at: new Date(now()).toISOString() });
    return res;
  }) as SatoCheckedFetch;

  wrapped.attemptKey = attemptKey;
  wrapped.resolveAttempt = async (key, state) => {
    const prior = await store.get(key);
    if (!prior) throw new Error(`No payment attempt recorded under ${key}.`);
    await store.put({ ...prior, state, updated_at: new Date(now()).toISOString() });
  };
  return wrapped;
}
