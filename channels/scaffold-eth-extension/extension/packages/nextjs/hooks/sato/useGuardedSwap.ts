// useGuardedSwap — prepare a swap through the Sato Kit pre-flight, show it,
// and only then ask the connected wallet to sign it.
import { useCallback, useState } from "react";
import type { PreparedIntent } from "@satohub/kit";
import { useAccount, useSendTransaction } from "wagmi";
import type { GuardedSwapInput, GuardedSwapResult } from "~~/utils/sato/walletTx";
import { walletTxFor } from "~~/utils/sato/walletTx";

export type SwapForm = Omit<GuardedSwapInput, "taker">;

export function useGuardedSwap() {
  const { address } = useAccount();
  const { sendTransactionAsync, isPending: isSending } = useSendTransaction();
  const [result, setResult] = useState<GuardedSwapResult | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);

  const prepare = useCallback(
    async (form: SwapForm) => {
      if (!address) {
        setResult({ ok: false, error: "connect a wallet first" });
        return;
      }
      setIsPreparing(true);
      setTxHash(null);
      try {
        const res = await fetch("/api/sato/prepare", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "prepare", input: { ...form, taker: address } }),
        });
        setResult((await res.json()) as GuardedSwapResult);
      } catch (e) {
        setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
      } finally {
        setIsPreparing(false);
      }
    },
    [address],
  );

  /** Sends ONLY the intent the person just reviewed; walletTxFor blocks refused, failed or expired intents. */
  const send = useCallback(
    async (intent: PreparedIntent) => {
      const w = walletTxFor(intent);
      if ("blocked" in w) throw new Error(w.blocked);
      const hash = await sendTransactionAsync(w.tx);
      setTxHash(hash);
      return hash;
    },
    [sendTransactionAsync],
  );

  return { prepare, send, result, isPreparing, isSending, txHash, reset: () => setResult(null) };
}
