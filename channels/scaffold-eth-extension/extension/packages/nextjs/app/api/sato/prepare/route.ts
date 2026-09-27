// POST /api/sato/prepare — quote or prepare one swap with the Sato Kit pre-flight.
// Server only: the kit here has no signer and cannot move funds. The browser
// wallet signs the returned unsigned transaction after the person approves it.
import { NextResponse } from "next/server";
import type { OdaChain } from "@satohub/kit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildGuardedSwapKit, prepareGuardedSwap } from "~~/utils/sato/guardedSwap";
import type { GuardedSwapInput } from "~~/utils/sato/guardedSwap";

export const dynamic = "force-dynamic";

async function readPolicy(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(process.cwd(), "policy.json"), "utf8"));
  } catch {
    return {}; // the kit's default policy: network "fork"
  }
}

const rpcUrl = (chain: OdaChain) => process.env[`SATO_RPC_URL_${chain.toUpperCase().replace(/-/g, "_")}`];

export async function POST(req: Request) {
  let body: { mode?: "quote" | "prepare"; input?: GuardedSwapInput };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 });
  }
  if (!body.input) return NextResponse.json({ ok: false, error: "input is required" }, { status: 400 });
  try {
    const kit = buildGuardedSwapKit({ policy: await readPolicy(), rpcUrl });
    if (body.mode === "quote") {
      const quote = await kit.read("swap.quote", {
        chain: body.input.chain,
        sell_token: body.input.sell_token,
        buy_token: body.input.buy_token,
        sell_amount: body.input.sell_amount,
        venue: body.input.venue ?? "direct",
      });
      return NextResponse.json({ ok: true, quote });
    }
    return NextResponse.json(await prepareGuardedSwap(kit, body.input));
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
