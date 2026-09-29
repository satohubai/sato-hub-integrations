// ACTIONS builder (K4). solana.read — read-only Solana state over JSON-RPC:
//   sol_balance    getBalance(address)                         -> lamports
//   token_balance  getTokenAccountsByOwner(owner, {mint}) jsonParsed -> summed base units + each account
//   token_account  getAccountInfo(address) jsonParsed          -> the parsed token account (or mint)
// Nothing is signed or sent.
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor } from "../spec/index.js";
import type { ActionContext, ReadAction } from "../types.js";
import { ActionInputError, isoNow, obj } from "./_util.js";
import { SOLANA_CLUSTERS, cluster, clusterSchema, pubkey, pubkeySchema, solanaRpcFor } from "./_solana.js";
import type { SolanaCluster } from "../types.js";

const ID = "solana.read";
export const SOLANA_READ_KINDS = ["sol_balance", "token_balance", "token_account"] as const;
export type SolanaReadKind = (typeof SOLANA_READ_KINDS)[number];

export const SOLANA_READ_FIXTURES = [
  "test/fixtures/solana-rpc.get-balance.json",
  "test/fixtures/solana-rpc.token-accounts-by-owner.json",
  "test/fixtures/solana-rpc.account-info.mint.json",
];

export type SolanaReadOutput = {
  kind: SolanaReadKind;
  chain: SolanaCluster;
  address: string;
  mint: string | null;
  /** Base units as a decimal string (lamports for sol_balance); null when the account does not exist. */
  amount: string | null;
  decimals: number | null;
  /** token_balance: every token account found for the mint; token_account: the parsed account. */
  accounts: Array<{ address: string; amount: string; program: string | null }> | null;
  account: unknown;
  slot: number | null;
  as_of: string;
};

export function solanaReadDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Read Solana state",
    description:
      "Reads Solana state over JSON-RPC: the SOL balance of an address in lamports, the balance of one SPL token (by mint) across the owner's token accounts, or a token account's parsed contents. Read only: nothing is signed or sent.",
    effects: ["read"],
    custody: { reads_key: false, sends_key: false, moves_funds: "never" },
    chains: [...SOLANA_CLUSTERS],
    input_schema: {
      type: "object",
      properties: {
        chain: clusterSchema(SOLANA_CLUSTERS),
        kind: { type: "string", enum: [...SOLANA_READ_KINDS], description: "sol_balance, token_balance (needs mint) or token_account." },
        address: pubkeySchema("The wallet (for sol_balance and token_balance) or the token account (for token_account)."),
        mint: pubkeySchema("The SPL token mint, for token_balance."),
      },
      required: ["chain", "kind", "address"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...SOLANA_READ_KINDS] },
        chain: { type: "string", enum: [...SOLANA_CLUSTERS] },
        address: pubkeySchema("The address read."),
        mint: { description: "The mint read, or null." },
        amount: { description: "Base units as a decimal string, or null when the account does not exist." },
        decimals: { description: "The mint's decimals when the RPC returned them, else null." },
        accounts: { description: "token_balance: the token accounts found; null otherwise." },
        account: { description: "token_account: the parsed account as the RPC returned it; null otherwise." },
        slot: { description: "The slot the RPC answered at, or null." },
        as_of: { type: "string" },
      },
      required: ["kind", "chain", "address", "amount", "as_of"],
    },
    policy: { rules: [] },
    receipt: false,
    fixtures: [...SOLANA_READ_FIXTURES],
    upstream: {},
    sponsored: null,
  };
}

type Ctx<T> = { context?: { slot?: number }; value?: T };
const slotOf = (r: Ctx<unknown> | null) => (typeof r?.context?.slot === "number" ? r.context.slot : null);

export async function solanaRead(input: unknown, ctx: ActionContext): Promise<SolanaReadOutput> {
  const o = obj(input, ID);
  const chain = cluster(o.chain, SOLANA_CLUSTERS, ID);
  const kind = o.kind as SolanaReadKind;
  if (!SOLANA_READ_KINDS.includes(kind)) throw new ActionInputError(`${ID}: kind must be one of ${SOLANA_READ_KINDS.join(", ")}`);
  const address = pubkey(o.address, "address", ID);
  const rpc = solanaRpcFor(ctx, chain, ID);
  const base = { kind, chain, address, as_of: isoNow(ctx) };

  if (kind === "sol_balance") {
    const r = (await rpc.request("getBalance", [address, { commitment: "confirmed" }])) as Ctx<number> | null;
    if (typeof r?.value !== "number") throw new Error(`${ID}: getBalance returned no value`);
    return { ...base, mint: null, amount: String(r.value), decimals: 9, accounts: null, account: null, slot: slotOf(r) };
  }

  if (kind === "token_balance") {
    const mint = pubkey(o.mint, "mint", ID);
    type Acct = { pubkey: string; account: { owner?: string; data?: { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } } } };
    const r = (await rpc.request("getTokenAccountsByOwner", [address, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }])) as Ctx<Acct[]> | null;
    if (!Array.isArray(r?.value)) throw new Error(`${ID}: getTokenAccountsByOwner returned no value`);
    let total = 0n;
    let decimals: number | null = null;
    const accounts = r.value.map((a) => {
      const ta = a.account?.data?.parsed?.info?.tokenAmount;
      const amt = typeof ta?.amount === "string" && /^[0-9]+$/.test(ta.amount) ? ta.amount : "0";
      if (typeof ta?.decimals === "number") decimals = ta.decimals;
      total += BigInt(amt);
      return { address: a.pubkey, amount: amt, program: typeof a.account?.owner === "string" ? a.account.owner : null };
    });
    // No token account for the mint is a real zero balance: the RPC answered with an empty list.
    return { ...base, mint, amount: total.toString(), decimals, accounts, account: null, slot: slotOf(r) };
  }

  type Info = { owner?: string; data?: { parsed?: { type?: string; info?: Record<string, unknown> }; program?: string } };
  const r = (await rpc.request("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }])) as Ctx<Info | null> | null;
  const v = r?.value ?? null;
  if (!v) return { ...base, mint: null, amount: null, decimals: null, accounts: null, account: null, slot: slotOf(r) };
  const info = v.data?.parsed?.info ?? {};
  const ta = info.tokenAmount as { amount?: string; decimals?: number } | undefined;
  return {
    ...base,
    mint: typeof info.mint === "string" ? info.mint : null,
    amount: typeof ta?.amount === "string" ? ta.amount : null,
    decimals: typeof ta?.decimals === "number" ? ta.decimals : typeof info.decimals === "number" ? (info.decimals as number) : null,
    accounts: null,
    account: { program: v.data?.program ?? null, owner_program: v.owner ?? null, type: v.data?.parsed?.type ?? null, info },
    slot: slotOf(r),
  };
}

export function solanaReadAction(): ReadAction<unknown, SolanaReadOutput> {
  return { descriptor: solanaReadDescriptor(), run: solanaRead };
}
