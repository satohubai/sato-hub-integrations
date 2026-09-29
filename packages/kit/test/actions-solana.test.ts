// K4: solana.read, solana.transfer, solana.swap.quote / solana.swap.prepare.
// Offline: recorded fixtures behind a fake fetch and a fake Solana RPC, a
// throwaway devnet key generated in memory. No network, no mainnet signing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address as solAddress,
  getAddressEncoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
} from "@solana/kit";
import { createKit } from "../src/kit.js";
import { memoryReceiptLog } from "../src/receipts/index.js";
import { solanaLocalSigner } from "../src/signers/index.js";
import { SOLANA_SIGNATURE_RE, validateReceipt, validateUnsignedPayload } from "../src/spec/index.js";
import type { UnsignedSolanaTx } from "../src/spec/index.js";
import type { SolanaRpc } from "../src/types.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, associatedTokenAddress, base58Decode, base58Encode, compileUnsignedLegacyTx,
  fromBase64, readTransaction, systemTransferIx,
} from "../src/solana/codec.js";
import { solanaActions, solanaRead, solanaSwapQuote, buildSolanaSwapPrepare, buildSolanaTransfer, NO_SATO_FEE_SOLANA } from "../src/actions/solana.js";
import { coreActions } from "../src/actions/registry.js";
import { DEFAULT_POLICY, ctxWith, fakeFetch, fixture } from "./fixtures/actions-harness.js";
import type { Route } from "./fixtures/actions-harness.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER = "GwRkq9EBWwcLNbFzYYGSKkgoBYo4grLvCV67dHoEZ4ZB";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SATO_HOST = "satohub.ai";

type Call = { method: string; params: readonly unknown[] };
function fakeRpc(handlers: Record<string, (params: readonly unknown[]) => unknown>): { rpc: SolanaRpc; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    rpc: {
      async request(method, params) {
        calls.push({ method, params });
        const h = handlers[method];
        if (!h) throw new Error(`fake rpc: ${method} not stubbed`);
        return h(params);
      },
    },
  };
}

const res = (name: string) => fixture(name).result;
const body = (name: string) => fixture(name).body;

// ── codec ────────────────────────────────────────────────────────────────────

test("codec: base58 round-trips, including leading zero bytes", () => {
  for (const s of [WALLET, USDC, "11111111111111111111111111111111", WSOL_MINT]) assert.equal(base58Encode(base58Decode(s)), s);
  assert.equal(base58Decode("11111111111111111111111111111111").length, 32);
});

test("codec: associated token address matches @solana/kit's program-derived address", async () => {
  for (const [owner, mint] of [[WALLET, USDC], [OTHER, WSOL_MINT], [WALLET, DEVNET_USDC]] as Array<[string, string]>) {
    const enc = getAddressEncoder();
    const [pda] = await getProgramDerivedAddress({
      programAddress: solAddress(ASSOCIATED_TOKEN_PROGRAM_ID),
      seeds: [enc.encode(solAddress(owner)), enc.encode(solAddress(TOKEN_PROGRAM_ID)), enc.encode(solAddress(mint))],
    });
    assert.equal(associatedTokenAddress(owner, mint), pda);
  }
  // A known public pair: the USDC account the recorded getTokenAccountsByOwner lists is NOT the ATA; the ATA is derived.
  assert.notEqual(associatedTokenAddress(WALLET, USDC), WALLET);
});

test("codec: a compiled legacy transfer decodes with @solana/kit and reads back its fee payer and blockhash", () => {
  const bh = res("solana-rpc.latest-blockhash.devnet.json").value.blockhash;
  const bytes = compileUnsignedLegacyTx(WALLET, bh, [systemTransferIx(WALLET, OTHER, 5000n)]);
  const tx = getTransactionDecoder().decode(bytes);
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(msg.version, "legacy");
  assert.equal(msg.staticAccounts[0], WALLET);
  assert.equal(msg.lifetimeToken, bh);
  assert.deepEqual(msg.header, { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 1 });
  assert.equal(Object.keys(tx.signatures).length, 1);
  const s = readTransaction(bytes);
  assert.deepEqual([s.fee_payer, s.recent_blockhash, s.version], [WALLET, bh, "legacy"]);
});

test("codec: reads the fee payer and blockhash of Jupiter's recorded v0 transaction", () => {
  const b = body("jupiter-swap.solana.json");
  const s = readTransaction(fromBase64(b.swapTransaction));
  assert.equal(s.version, 0);
  assert.equal(s.fee_payer, WALLET);
  const msg = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(b.swapTransaction)).messageBytes);
  assert.equal(msg.lifetimeToken, s.recent_blockhash);
});

// ── registry + descriptors ──────────────────────────────────────────────────

test("the Solana actions are registered after the core set, in a stable order", () => {
  const ids = coreActions().map((a) => a.descriptor.id);
  assert.deepEqual(ids.slice(-4), ["solana.read", "solana.transfer", "solana.swap.quote", "solana.swap.prepare"]);
  assert.deepEqual(solanaActions().map((a) => a.descriptor.name), ["solana_read", "solana_transfer", "solana_swap_quote", "solana_swap_prepare"]);
});

// ── solana.read ─────────────────────────────────────────────────────────────

const readRpc = () => fakeRpc({
  getBalance: () => res("solana-rpc.get-balance.json"),
  getTokenAccountsByOwner: () => res("solana-rpc.token-accounts-by-owner.json"),
  getAccountInfo: () => res("solana-rpc.account-info.mint.json"),
});

test("solana.read: sol_balance, token_balance (summed across accounts) and token_account", async () => {
  const f = readRpc();
  const ctx = ctxWith({ extra: { solanaRpc: () => f.rpc } });
  const bal = await solanaRead({ chain: "solana", kind: "sol_balance", address: WALLET }, ctx);
  assert.equal(bal.amount, String(res("solana-rpc.get-balance.json").value));
  assert.equal(bal.decimals, 9);
  const tok = await solanaRead({ chain: "solana", kind: "token_balance", address: WALLET, mint: USDC }, ctx);
  const accts = res("solana-rpc.token-accounts-by-owner.json").value as Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }>;
  assert.equal(tok.amount, accts.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n).toString());
  assert.equal(tok.accounts?.length, 2);
  assert.equal(tok.decimals, 6);
  assert.deepEqual(f.calls[1]!.params[1], { mint: USDC });
  const acct = await solanaRead({ chain: "solana", kind: "token_account", address: USDC }, ctx);
  assert.equal(acct.decimals, 6);
  assert.equal((acct.account as { type: string }).type, "mint");
});

test("solana.read: a missing account reads as null, never zero; bad input and no RPC are refused", async () => {
  const f = fakeRpc({ getAccountInfo: () => ({ context: { slot: 1 }, value: null }) });
  const out = await solanaRead({ chain: "solana-devnet", kind: "token_account", address: WALLET }, ctxWith({ extra: { solanaRpc: () => f.rpc } }));
  assert.equal(out.amount, null);
  await assert.rejects(solanaRead({ chain: "solana", kind: "sol_balance", address: "0xabc" }, ctxWith({ extra: { solanaRpc: () => f.rpc } })), /base58/);
  await assert.rejects(solanaRead({ chain: "solana", kind: "sol_balance", address: WALLET }, ctxWith()), /no Solana RPC/);
});

// ── solana.transfer ─────────────────────────────────────────────────────────

function transferRpc(o: { recipientAtaExists: boolean; senderAtaExists?: boolean; from: string; to: string }) {
  const senderAta = associatedTokenAddress(o.from, DEVNET_USDC);
  const recipientAta = associatedTokenAddress(o.to, DEVNET_USDC);
  const present = { context: { slot: 1 }, value: { lamports: 2039280, owner: TOKEN_PROGRAM_ID, data: ["", "base64"] } };
  const absent = { context: { slot: 1 }, value: null };
  return fakeRpc({
    getLatestBlockhash: () => res("solana-rpc.latest-blockhash.devnet.json"),
    getGenesisHash: () => DEVNET_GENESIS,
    simulateTransaction: () => ({ context: { slot: 99 }, value: { err: null, logs: [], unitsConsumed: 4321 } }),
    sendTransaction: () => "5".repeat(88),
    getAccountInfo: (p) => {
      if (p[0] === DEVNET_USDC) return res("solana-rpc.account-info.mint.devnet.json");
      if (p[0] === senderAta) return o.senderAtaExists === false ? absent : present;
      if (p[0] === recipientAta) return o.recipientAtaExists ? present : absent;
      throw new Error(`unexpected account ${String(p[0])}`);
    },
  });
}

function decodeIxPrograms(u: UnsignedSolanaTx): string[] {
  const msg = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(u.transaction_base64)).messageBytes);
  const ixs = (msg as unknown as { instructions?: Array<{ programAddressIndex: number }> }).instructions ?? [];
  return ixs.map((ix) => String(msg.staticAccounts[ix.programAddressIndex]));
}

test("solana.transfer: SOL on devnet is one System transfer with the recorded blockhash", async () => {
  const f = transferRpc({ recipientAtaExists: true, from: WALLET, to: OTHER });
  const b = await buildSolanaTransfer({ chain: "solana-devnet", from: WALLET, to: OTHER, amount: "1000000" }, ctxWith({ extra: { solanaRpc: () => f.rpc } }));
  const u = b.unsigned as UnsignedSolanaTx;
  assert.equal(validateUnsignedPayload(u).ok, true);
  assert.equal(u.recent_blockhash, res("solana-rpc.latest-blockhash.devnet.json").value.blockhash);
  assert.equal(u.last_valid_block_height, res("solana-rpc.latest-blockhash.devnet.json").value.lastValidBlockHeight);
  assert.deepEqual(decodeIxPrograms(u), ["11111111111111111111111111111111"]);
  assert.equal(b.facts.token, "SOL");
  assert.equal(b.facts.network, "testnet");
  assert.equal(b.facts.usd_value, null);
  assert.equal(b.fee_disclosure, null);
});

test("solana.transfer: SPL creates the recipient's token account only when it is missing, and says so", async () => {
  const missing = transferRpc({ recipientAtaExists: false, from: WALLET, to: OTHER });
  const a = await buildSolanaTransfer({ chain: "solana-devnet", from: WALLET, to: OTHER, amount: "2500000", mint: DEVNET_USDC }, ctxWith({ extra: { solanaRpc: () => missing.rpc } }));
  assert.deepEqual(decodeIxPrograms(a.unsigned as UnsignedSolanaTx), [ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID]);
  assert.equal((a.params as { creates_recipient_account: boolean }).creates_recipient_account, true);
  assert.match(a.summary, /also creates/);
  assert.equal(a.facts.usd_value, 2.5, "devnet USDC at the stated 1 unit = 1 USD assumption");
  assert.equal(a.facts.token, DEVNET_USDC);

  const exists = transferRpc({ recipientAtaExists: true, from: WALLET, to: OTHER });
  const b = await buildSolanaTransfer({ chain: "solana-devnet", from: WALLET, to: OTHER, amount: "2500000", mint: DEVNET_USDC }, ctxWith({ extra: { solanaRpc: () => exists.rpc } }));
  assert.deepEqual(decodeIxPrograms(b.unsigned as UnsignedSolanaTx), [TOKEN_PROGRAM_ID]);
  assert.equal((b.params as { creates_recipient_account: boolean }).creates_recipient_account, false);
  assert.match(b.summary, /nothing is created/);

  const noSource = transferRpc({ recipientAtaExists: true, senderAtaExists: false, from: WALLET, to: OTHER });
  await assert.rejects(buildSolanaTransfer({ chain: "solana-devnet", from: WALLET, to: OTHER, amount: "1", mint: DEVNET_USDC }, ctxWith({ extra: { solanaRpc: () => noSource.rpc } })), /no associated token account/);
});

test("solana.transfer: prepare -> execute on devnet with a throwaway key; the receipt carries the signature", async () => {
  let f!: ReturnType<typeof transferRpc>;
  const signer = solanaLocalSigner({ generate: true, rpc: () => f.rpc });
  const from = await signer.publicKey();
  f = transferRpc({ recipientAtaExists: false, from, to: OTHER });
  const receipts = memoryReceiptLog();
  const kit = createKit({
    policy: { ...DEFAULT_POLICY, allow_tokens: ["solana-devnet:SOL"] },
    secret: new Uint8Array(32).fill(3), signer, receipts, solanaRpc: () => f.rpc,
    rpc: () => { throw new Error("no evm rpc"); }, fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
    clock: () => Date.UTC(2026, 8, 28), actions: coreActions(),
  });
  const p = await kit.prepare("solana.transfer", { chain: "solana-devnet", from, to: OTHER, amount: "1000" });
  assert.equal(p.policy.ok, true, JSON.stringify(p.policy.refusals));
  assert.equal(p.simulation?.method, "simulateTransaction");
  assert.equal(p.simulation?.gas_estimate, "4321");
  const sim = f.calls.find((c) => c.method === "simulateTransaction")!;
  assert.equal((sim.params[1] as { sigVerify: boolean }).sigVerify, false);
  const r = await kit.execute({ intent_id: p.intent_id });
  assert.equal(r.status, "executed");
  assert.equal(r.tx_hash, null);
  assert.match(r.signature ?? "", SOLANA_SIGNATURE_RE);
  assert.equal(validateReceipt(r).ok, true);
  const sent = f.calls.find((c) => c.method === "sendTransaction")!;
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(sent.params[0] as string));
  assert.ok(Object.values(decoded.signatures)[0], "the sent transaction is signed");

  // A token outside allow_tokens is refused by the pre-flight, named as "<chain>:<mint>".
  const q = await kit.prepare("solana.transfer", { chain: "solana-devnet", from, to: OTHER, amount: "1", mint: DEVNET_USDC });
  assert.ok(q.policy.refusals.some((x) => x.rule === "token_allowlist" && x.observed === `solana-devnet:${DEVNET_USDC}`));
});

test("solana.transfer on mainnet is refused by a policy whose network is not mainnet", async () => {
  const f = transferRpc({ recipientAtaExists: true, from: WALLET, to: OTHER });
  const kit = createKit({
    policy: { ...DEFAULT_POLICY, network: "testnet" }, secret: new Uint8Array(32).fill(3), solanaRpc: () => f.rpc,
    rpc: () => { throw new Error("no evm rpc"); }, fetch: (async () => { throw new Error("no network"); }) as typeof fetch,
    clock: () => Date.UTC(2026, 8, 28), actions: coreActions(),
  });
  const p = await kit.prepare("solana.transfer", { chain: "solana", from: WALLET, to: OTHER, amount: "1000" });
  assert.ok(p.policy.refusals.some((x) => x.rule === "network_mainnet_not_enabled"));
});

// ── swaps ───────────────────────────────────────────────────────────────────

const swapRoutes = (): Route[] => [
  { match: (u) => u.startsWith("https://satohub.ai/api/swap/quote"), body: body("sato-swap-recommend.solana.json") },
  { match: (u) => u.includes("lite-api.jup.ag/swap/v1/quote") && u.includes("platformFeeBps"), body: body("jupiter-quote-fee.solana.json") },
  { match: (u) => u.includes("lite-api.jup.ag/swap/v1/quote"), body: body("jupiter-quote.solana.json") },
  { match: (u) => u.includes("lite-api.jup.ag/swap/v1/swap"), body: body("jupiter-swap.solana.json") },
];
const swapIn = { chain: "solana", input_mint: "SOL", output_mint: USDC, amount: "100000000" };

test("solana.swap.quote default: Sato's quote with its fee sentence verbatim, beside a Jupiter quote with no Sato fee, unranked", async () => {
  const ff = fakeFetch(swapRoutes());
  const out = await solanaSwapQuote(swapIn, ctxWith({ fetch: ff.fetch }));
  assert.deepEqual(out.quotes.map((q) => q.venue), ["sato", "jupiter"]);
  assert.equal(out.order, "as_requested");
  const sato = body("sato-swap-recommend.solana.json");
  assert.equal(out.quotes[0]!.fee_disclosure, sato.disclosure);
  assert.equal(out.quotes[0]!.sato_fee_bps, sato.sato_fee_bps);
  assert.equal(out.quotes[0]!.sato_fee_recipient, sato.sato_fee_recipient);
  assert.equal(out.quotes[1]!.sato_fee_bps, 0);
  assert.equal(out.quotes[1]!.fee_disclosure, NO_SATO_FEE_SOLANA);
  assert.equal(out.quotes[1]!.out_amount, body("jupiter-quote.solana.json").outAmount);
  const jup = ff.calls.find((c) => c.url.includes("jup.ag"))!;
  assert.doesNotMatch(jup.url, /platformFeeBps/);
  assert.match(jup.url, new RegExp(`inputMint=${WSOL_MINT}`));
  const satoCall = ff.calls.find((c) => c.url.includes(SATO_HOST))!;
  assert.deepEqual(satoCall.body, { chain_in: "solana", token_in: WSOL_MINT, token_out: USDC, amount_in: "100000000", slippage_bps: 50, mode: "recommend" });
  for (const q of out.quotes) assert.equal("rank" in q || "best" in q, false);
});

for (const venue of ["direct", "jupiter"]) {
  test(`solana.swap.quote / prepare with venue ${venue} never call satohub.ai`, async () => {
    const ff = fakeFetch(swapRoutes());
    const q = await solanaSwapQuote({ ...swapIn, venue }, ctxWith({ fetch: ff.fetch }));
    assert.deepEqual(q.quotes.map((x) => x.venue), ["jupiter"]);
    const b = await buildSolanaSwapPrepare({ ...swapIn, venue, taker: WALLET }, ctxWith({ fetch: ff.fetch }));
    assert.equal(ff.calls.some((c) => c.url.includes(SATO_HOST)), false);
    const swap = ff.calls.find((c) => c.url.endsWith("/swap"))!;
    assert.equal("feeAccount" in (swap.body as object), false);
    assert.equal(b.fee_disclosure?.venue, "jupiter");
    assert.match(b.fee_disclosure?.statement ?? "", /No Sato fee/);
    assert.equal((b.params as { sato_fee_bps: number }).sato_fee_bps, 0);
  });
}

test("solana.swap.prepare sato: Jupiter builds the transaction with the fee Sato Route states, paid into the account it names", async () => {
  const ff = fakeFetch(swapRoutes());
  const b = await buildSolanaSwapPrepare({ ...swapIn, taker: WALLET }, ctxWith({ fetch: ff.fetch }));
  const sato = body("sato-swap-recommend.solana.json");
  const quoteCall = ff.calls.find((c) => c.url.includes("/swap/v1/quote"))!;
  assert.match(quoteCall.url, new RegExp(`platformFeeBps=${sato.sato_fee_bps}`));
  const swap = ff.calls.find((c) => c.url.endsWith("/swap"))!;
  assert.equal((swap.body as { feeAccount: string }).feeAccount, sato.sato_fee_recipient);
  assert.equal((swap.body as { userPublicKey: string }).userPublicKey, WALLET);
  assert.deepEqual((swap.body as { quoteResponse: unknown }).quoteResponse, body("jupiter-quote-fee.solana.json"));
  const u = b.unsigned as UnsignedSolanaTx;
  assert.equal(validateUnsignedPayload(u).ok, true);
  assert.equal(u.transaction_base64, body("jupiter-swap.solana.json").swapTransaction);
  assert.equal(u.last_valid_block_height, body("jupiter-swap.solana.json").lastValidBlockHeight);
  assert.equal(u.fee_payer, WALLET);
  assert.deepEqual(b.fee_disclosure, { venue: "sato", fee_bps: sato.sato_fee_bps, fee_recipient: sato.sato_fee_recipient, statement: sato.disclosure, direct_quote_available: true });
  assert.equal(b.facts.usd_value, Number(body("jupiter-quote-fee.solana.json").swapUsdValue), "venue figure: Jupiter's swapUsdValue");
  assert.equal(b.facts.token, WSOL_MINT);
  assert.equal(b.facts.network, "mainnet");
  assert.equal(b.facts.venue, "sato");
});

test("solana.swap.prepare: a transaction whose fee payer is not the taker is refused; no swapUsdValue falls back to a stablecoin leg", async () => {
  const ff = fakeFetch(swapRoutes());
  await assert.rejects(buildSolanaSwapPrepare({ ...swapIn, venue: "direct", taker: OTHER }, ctxWith({ fetch: ff.fetch })), /fee payer/);
  const noUsd = { ...body("jupiter-quote.solana.json") };
  delete noUsd.swapUsdValue;
  const ff2 = fakeFetch([{ match: (u) => u.includes("/swap/v1/quote"), body: noUsd }, ...swapRoutes()]);
  const b = await buildSolanaSwapPrepare({ ...swapIn, venue: "direct", taker: WALLET }, ctxWith({ fetch: ff2.fetch }));
  assert.ok(Math.abs((b.facts.usd_value as number) - Number(noUsd.outAmount) / 1e6) < 1e-9);
  assert.match((b.params as { usd_value_source: string }).usd_value_source, /assuming 1 USDC = 1 USD/);
});

test("solana.swap.prepare sato: when Sato cannot answer nothing is prepared and the direct venue is named", async () => {
  const ff = fakeFetch([{ match: (u) => u.includes(SATO_HOST), status: 503, body: { error: "down" } }, ...swapRoutes()]);
  await assert.rejects(buildSolanaSwapPrepare({ ...swapIn, taker: WALLET }, ctxWith({ fetch: ff.fetch })), /venue direct/);
  assert.equal(ff.calls.some((c) => c.url.includes("jup.ag")), false);
  void DEFAULT_POLICY;
});
