// ACTIONS builder (K4). solana.transfer — prepare a SOL or SPL token transfer
// as an UNSIGNED solana_tx with a recent blockhash. Nothing here holds a key;
// only execute (with a signer that has the Solana capability) can move funds.
//
//   SOL: one System Program transfer (lamports).
//   SPL: TransferChecked from the sender's associated token account to the
//        recipient's. When the recipient's associated token account does not
//        exist yet, a Create instruction for it is added first, paid by the
//        sender, and the summary and params say so. When it exists, nothing
//        is created.
import { ACTION_SCHEMA_ID, odaIdToToolName } from "../spec/index.js";
import type { ActionDescriptor, UnsignedSolanaTx } from "../spec/index.js";
import type { ActionContext, PrepareAction, PrepareBuild, SolanaCluster } from "../types.js";
import { ActionInputError, baseUnits, obj } from "./_util.js";
import {
  SOLANA_CLUSTERS, baseUnitsToNumber, cluster, clusterSchema, networkOf, pubkey, pubkeySchema, solanaRpcFor, stableOf,
} from "./_solana.js";
import {
  SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, associatedTokenAddress, compileUnsignedLegacyTx, createAtaIx,
  systemTransferIx, toBase64, transferCheckedIx,
} from "../solana/codec.js";
import type { Instruction } from "../solana/codec.js";

const ID = "solana.transfer";

export const SOLANA_TRANSFER_FIXTURES = [
  "test/fixtures/solana-rpc.latest-blockhash.devnet.json",
  "test/fixtures/solana-rpc.account-info.mint.devnet.json",
];

export type SolanaTransferParams = {
  chain: SolanaCluster;
  asset: "SOL" | "SPL";
  mint: string | null;
  from: string;
  to: string;
  amount: string;
  decimals: number;
  token_program: string;
  source_account: string;
  destination_account: string;
  /** True when this transaction also creates the recipient's associated token account. */
  creates_recipient_account: boolean;
  recent_blockhash: string;
  last_valid_block_height: number;
  usd_value: number | null;
  usd_value_source: string;
};

export function solanaTransferDescriptor(): ActionDescriptor {
  return {
    schema: ACTION_SCHEMA_ID,
    id: ID,
    name: odaIdToToolName(ID),
    version: "0.1.0",
    title: "Prepare a Solana transfer",
    description:
      "Builds an unsigned Solana transaction that sends SOL, or an SPL token by mint, from one address to another, with a recent blockhash. For a token, it also creates the recipient's associated token account when that account does not exist yet, funded by the sender, and says so. It returns an intent to review and runs the policy pre-flight and a simulation; nothing moves until execute hands it to your signer.",
    effects: ["sign", "broadcast"],
    custody: { reads_key: false, sends_key: false, moves_funds: "with_approval" },
    chains: [...SOLANA_CLUSTERS],
    input_schema: {
      type: "object",
      properties: {
        chain: clusterSchema(SOLANA_CLUSTERS),
        from: pubkeySchema("Sender and fee payer: the key that will sign."),
        to: pubkeySchema("Recipient wallet (for a token, its owner; the associated token account is derived)."),
        amount: { type: "string", pattern: "^[0-9]{1,20}$", description: "Amount in base units (lamports for SOL) as a decimal string." },
        mint: pubkeySchema("SPL token mint. Omit to send SOL."),
      },
      required: ["chain", "from", "to", "amount"],
      additionalProperties: false,
    },
    output_schema: {
      type: "object",
      description: "A PreparedIntent (sato.action/v1 intent shape) whose unsigned payload is a solana_tx.",
      properties: {
        intent_id: { type: "string", pattern: "^si_[A-Za-z0-9_-]{43}$" },
        action: { type: "string" },
        expires_at: { type: "string" },
        summary: { type: "string" },
        policy: { type: "object" },
        simulation: { description: "SimulationResult from simulateTransaction, or null when the policy refused first." },
        fee_disclosure: { description: "Always null: a transfer involves no venue." },
        unsigned: { type: "object", description: "UnsignedSolanaTx." },
      },
      required: ["intent_id", "action", "expires_at", "summary", "policy", "simulation", "unsigned"],
    },
    policy: {
      rules: [
        "network_mainnet_not_enabled", "chain_allowlist", "token_allowlist", "recipient_allowlist",
        "max_per_trade", "max_usd_per_trade", "max_usd_per_day", "unknown_price", "intent_ttl",
        "simulation_required", "simulation_failed",
      ],
    },
    receipt: true,
    fixtures: [...SOLANA_TRANSFER_FIXTURES],
    upstream: {},
    sponsored: null,
  };
}

type Ctx<T> = { context?: { slot?: number }; value?: T };

export async function latestBlockhash(ctx: ActionContext, chain: SolanaCluster, action: string): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const r = (await solanaRpcFor(ctx, chain, action).request("getLatestBlockhash", [{ commitment: "confirmed" }])) as Ctx<{ blockhash?: unknown; lastValidBlockHeight?: unknown }> | null;
  const v = r?.value;
  if (!v || typeof v.blockhash !== "string" || typeof v.lastValidBlockHeight !== "number") throw new Error(`${action}: getLatestBlockhash returned no blockhash`);
  return { blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight };
}

export async function buildSolanaTransfer(input: unknown, ctx: ActionContext): Promise<PrepareBuild> {
  const o = obj(input, ID);
  const chain = cluster(o.chain, SOLANA_CLUSTERS, ID);
  const from = pubkey(o.from, "from", ID);
  const to = pubkey(o.to, "to", ID);
  const amount = baseUnits(o.amount, "amount", ID);
  if (BigInt(amount) === 0n) throw new ActionInputError(`${ID}: amount must be greater than zero`);
  if (BigInt(amount) >= 2n ** 64n) throw new ActionInputError(`${ID}: amount does not fit in a u64`);
  const mint = o.mint === undefined || o.mint === null ? null : pubkey(o.mint, "mint", ID);
  if (from === to && !mint) throw new ActionInputError(`${ID}: from and to are the same address`);
  const rpc = solanaRpcFor(ctx, chain, ID);

  let ixs: Instruction[];
  let decimals = 9;
  let tokenProgram = SYSTEM_PROGRAM_ID;
  let source = from;
  let dest = to;
  let creates = false;
  if (!mint) {
    ixs = [systemTransferIx(from, to, BigInt(amount))];
  } else {
    const mi = (await rpc.request("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }])) as Ctx<{ owner?: string; data?: { parsed?: { type?: string; info?: { decimals?: number } } } } | null> | null;
    const m = mi?.value;
    if (!m) throw new ActionInputError(`${ID}: mint ${mint} does not exist on ${chain}`);
    if (m.owner !== TOKEN_PROGRAM_ID && m.owner !== TOKEN_2022_PROGRAM_ID) throw new ActionInputError(`${ID}: ${mint} is not owned by the SPL Token or Token-2022 program`);
    if (m.data?.parsed?.type !== "mint" || typeof m.data.parsed.info?.decimals !== "number") throw new ActionInputError(`${ID}: ${mint} is not a mint account`);
    decimals = m.data.parsed.info.decimals;
    tokenProgram = m.owner;
    source = associatedTokenAddress(from, mint, tokenProgram);
    dest = associatedTokenAddress(to, mint, tokenProgram);
    const [src, dst] = (await Promise.all([
      rpc.request("getAccountInfo", [source, { encoding: "base64", commitment: "confirmed" }]),
      rpc.request("getAccountInfo", [dest, { encoding: "base64", commitment: "confirmed" }]),
    ])) as Array<Ctx<unknown> | null>;
    if (!src?.value) throw new ActionInputError(`${ID}: the sender has no associated token account for ${mint} (${source}); nothing was prepared`);
    creates = !dst?.value;
    ixs = [
      ...(creates ? [createAtaIx(from, dest, to, mint, tokenProgram)] : []),
      transferCheckedIx(source, mint, dest, from, BigInt(amount), decimals, tokenProgram),
    ];
  }

  const { blockhash, lastValidBlockHeight } = await latestBlockhash(ctx, chain, ID);
  const unsigned: UnsignedSolanaTx = {
    kind: "solana_tx",
    chain,
    fee_payer: from,
    transaction_base64: toBase64(compileUnsignedLegacyTx(from, blockhash, ixs)),
    recent_blockhash: blockhash,
    last_valid_block_height: lastValidBlockHeight,
  };

  const stable = mint ? stableOf(chain, mint) : null;
  const usd = stable
    ? { usd_value: baseUnitsToNumber(amount, stable.decimals), source: `stablecoin: amount of ${stable.symbol} / 10^${stable.decimals}, assuming 1 ${stable.symbol} = 1 USD` }
    : { usd_value: null, source: "unknown: no venue priced this transfer and the asset is not a listed stablecoin" };

  const params: SolanaTransferParams = {
    chain, asset: mint ? "SPL" : "SOL", mint, from, to, amount, decimals, token_program: tokenProgram,
    source_account: source, destination_account: dest, creates_recipient_account: creates,
    recent_blockhash: blockhash, last_valid_block_height: lastValidBlockHeight,
    usd_value: usd.usd_value, usd_value_source: usd.source,
  };
  const what = mint ? `${amount} base units of token ${mint}` : `${amount} lamports of SOL`;
  const createNote = creates
    ? ` The recipient has no associated token account for this mint, so this transaction also creates ${dest}, paid by the sender (rent-exempt deposit).`
    : mint ? ` The recipient's associated token account ${dest} already exists; nothing is created.` : "";
  const summary = `Send ${what} from ${from} to ${to} on ${chain}.${createNote} Valid until block height ${lastValidBlockHeight}. USD value: ${usd.usd_value ?? "unknown"} (${usd.source}).`;

  return {
    params,
    unsigned,
    facts: {
      action: ID,
      chain,
      network: networkOf(chain),
      // The pre-flight checks allow_tokens against "<chain>:<token>", i.e. "solana:<mint>" (or "solana:SOL").
      token: mint ?? "SOL",
      token_amount_base_units: amount,
      usd_value: usd.usd_value,
      usd_spent_today: null,
      recipient: to,
    },
    summary,
    fee_disclosure: null,
  };
}

export function solanaTransferAction(): PrepareAction {
  return { descriptor: solanaTransferDescriptor(), build: buildSolanaTransfer };
}
