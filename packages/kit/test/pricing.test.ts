// M1 kit fix: swap.prepare derives usd_value honestly, and the kit fills
// usd_spent_today from the day's executed receipts. Offline, deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveUsdValue } from "../src/actions/swap_prepare.js";
import { createKit } from "../src/kit.js";
import type { PreflightFacts, PrepareAction } from "../src/types.js";
import { SECRET, T0, descriptor, fakeSigner, okSim, policy, rpc, tx } from "./kit-fixtures.js";
import type { UnsignedEvmTx } from "../src/spec/index.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DAI = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
const WETH = "0x4200000000000000000000000000000000000006";
const q = (o: Partial<Parameters<typeof deriveUsdValue>[0]>) => ({
  venue: "sato" as const, chain: "base" as const, sell_token: WETH, buy_token: WETH, sell_amount: "1", buy_amount: null, sell_usd: null, ...o,
});

test("venue USD field wins when present", () => {
  const r = deriveUsdValue(q({ venue: "lifi", sell_usd: 9.97, sell_token: USDC, sell_amount: "10000000" }));
  assert.equal(r.usd_value, 9.97);
  assert.match(r.source, /^venue: lifi/);
});

test("stablecoin sell leg: amount / 10^decimals, assumption stated", () => {
  const r = deriveUsdValue(q({ sell_token: USDC, sell_amount: "12345678" }));
  assert.equal(r.usd_value, 12.345678);
  assert.match(r.source, /assuming 1 USDC = 1 USD/);
  const d = deriveUsdValue(q({ sell_token: DAI.toLowerCase(), sell_amount: "2500000000000000000" }));
  assert.equal(d.usd_value, 2.5);
});

test("stablecoin buy leg uses the quoted buy amount", () => {
  const r = deriveUsdValue(q({ buy_token: USDC, buy_amount: "3000000" }));
  assert.equal(r.usd_value, 3);
  assert.match(r.source, /quoted buy_amount of USDC/);
});

test("no USD field and no stablecoin leg stays unknown", () => {
  const r = deriveUsdValue(q({}));
  assert.equal(r.usd_value, null);
  assert.match(r.source, /^unknown/);
  // A USDC address on a different chain is not a stablecoin there.
  assert.equal(deriveUsdValue(q({ chain: "ethereum" as never, sell_token: USDC })).usd_value, null);
});

function pricedAction(): PrepareAction<{ usd: number | null }> {
  return {
    descriptor: descriptor("test.buy", ["sign", "broadcast"]),
    async build(input) {
      return {
        params: { usd: input.usd },
        unsigned: tx,
        facts: { action: "test.buy", chain: "base-sepolia", network: "fork", usd_value: input.usd, usd_spent_today: null },
        summary: "buy",
        fee_disclosure: null,
      };
    },
  };
}

test("usd_spent_today sums executed receipts of the current UTC day only", async () => {
  let now = T0;
  const seen: PreflightFacts[] = [];
  const sent: UnsignedEvmTx[] = [];
  const kit = createKit({
    policy, rpc, secret: SECRET, clock: () => now, actions: [pricedAction()], signer: fakeSigner(sent),
    simulate: async () => okSim,
    evaluate: (_p, f) => { seen.push(f); return { ok: true, refusals: [] }; },
  });
  const a = await kit.prepare("test.buy", { usd: 4 });
  assert.equal(seen.at(-1)!.usd_spent_today, 0);
  await kit.execute({ intent_id: a.intent_id });
  const b = await kit.prepare("test.buy", { usd: 6.5 });
  assert.equal(seen.at(-1)!.usd_spent_today, 4);
  await kit.execute({ intent_id: b.intent_id });
  // A prepared-but-not-executed intent does not count.
  await kit.prepare("test.buy", { usd: 100 });
  assert.equal(seen.at(-1)!.usd_spent_today, 10.5);
  await kit.prepare("test.buy", { usd: 1 });
  assert.equal(seen.at(-1)!.usd_spent_today, 10.5);
  // Next UTC day starts at zero.
  now = T0 + 24 * 3600 * 1000;
  await kit.prepare("test.buy", { usd: 1 });
  assert.equal(seen.at(-1)!.usd_spent_today, 0);
});

test("an executed trade today with unknown USD makes the day's total unknown", async () => {
  const seen: PreflightFacts[] = [];
  const kit = createKit({
    policy, rpc, secret: SECRET, clock: () => T0, actions: [pricedAction()], signer: fakeSigner([]),
    simulate: async () => okSim,
    evaluate: (_p, f) => { seen.push(f); return { ok: true, refusals: [] }; },
  });
  const a = await kit.prepare("test.buy", { usd: null });
  await kit.execute({ intent_id: a.intent_id });
  await kit.prepare("test.buy", { usd: 2 });
  assert.equal(seen.at(-1)!.usd_spent_today, null);
});
