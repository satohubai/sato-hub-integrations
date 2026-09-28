"use client";

import { useState } from "react";
import type { NextPage } from "next";
import { useGuardedSwap } from "~~/hooks/sato/useGuardedSwap";
import { walletTxFor } from "~~/utils/sato/walletTx";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_BASE = "0x4200000000000000000000000000000000000006";

const SatoSwap: NextPage = () => {
  const { prepare, send, result, isPreparing, isSending, txHash } = useGuardedSwap();
  const [sellToken, setSellToken] = useState(USDC_BASE);
  const [buyToken, setBuyToken] = useState(WETH_BASE);
  const [sellAmount, setSellAmount] = useState("1000000");
  const [slippage, setSlippage] = useState(50);
  const [sendError, setSendError] = useState<string | null>(null);

  const intent = result?.ok ? result.intent : null;
  const gate = intent ? walletTxFor(intent) : null;

  return (
    <div className="flex flex-col items-center grow pt-10 px-4">
      <div className="max-w-2xl w-full">
        <h1 className="text-3xl font-bold mb-2">Guarded swap</h1>
        <p className="mb-6">
          Prepare builds an unsigned transaction, checks it against <code>policy.json</code> and simulates it. Your
          wallet is asked to sign only after you have read the result. The pre-flight explains refusals; your wallet
          confirmation is the signature.
        </p>

        <div className="flex flex-col gap-3 bg-base-100 rounded-3xl p-6">
          <label className="flex flex-col gap-1">
            Sell token (address)
            <input className="input input-bordered" value={sellToken} onChange={e => setSellToken(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Buy token (address)
            <input className="input input-bordered" value={buyToken} onChange={e => setBuyToken(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Sell amount (base units)
            <input className="input input-bordered" value={sellAmount} onChange={e => setSellAmount(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            Slippage (bps)
            <input
              className="input input-bordered"
              type="number"
              value={slippage}
              onChange={e => setSlippage(Number(e.target.value))}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={isPreparing}
            onClick={() =>
              prepare({
                chain: "base",
                sell_token: sellToken,
                buy_token: buyToken,
                sell_amount: sellAmount,
                slippage_bps: slippage,
                venue: "direct",
              })
            }
          >
            {isPreparing ? "Preparing…" : "Prepare"}
          </button>
        </div>

        {result && !result.ok && (
          <div className="mt-6 bg-base-100 rounded-3xl p-6">
            <h2 className="text-xl font-bold">Not prepared</h2>
            <p>{result.error}</p>
            {result.refusals?.map(r => (
              <p key={r.rule}>
                <code>{r.rule}</code>: limit {r.limit}, observed {r.observed}
              </p>
            ))}
          </div>
        )}

        {intent && (
          <div className="mt-6 flex flex-col gap-2 bg-base-100 rounded-3xl p-6">
            <h2 className="text-xl font-bold">Review</h2>
            <p>{intent.summary}</p>
            <p>
              Pre-flight: {intent.policy.ok ? "passed" : "refused"}
              {intent.policy.refusals.map(r => (
                <span key={r.rule} className="block">
                  <code>{r.rule}</code>: limit {r.limit}, observed {r.observed}
                </span>
              ))}
            </p>
            <p>
              Simulation:{" "}
              {intent.simulation
                ? intent.simulation.ok
                  ? "succeeded"
                  : `failed: ${intent.simulation.error}`
                : "not run"}
            </p>
            {intent.fee_disclosure && <p>Fee: {intent.fee_disclosure.statement}</p>}
            <p className="text-sm">Expires at {intent.expires_at}</p>
            {gate && "blocked" in gate ? (
              <p>Cannot send: {gate.blocked}.</p>
            ) : (
              <button
                className="btn btn-secondary"
                disabled={isSending}
                onClick={async () => {
                  setSendError(null);
                  try {
                    await send(intent);
                  } catch (e) {
                    setSendError(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                {isSending ? "Waiting for wallet…" : "Send this intent to my wallet"}
              </button>
            )}
            {sendError && <p>{sendError}</p>}
            {txHash && (
              <p>
                Submitted: <code>{txHash}</code>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default SatoSwap;
