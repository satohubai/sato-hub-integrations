// INTENT builder. Hash-chained sato.receipt/v1 JSONL.
//
// A local chain shows the log was not edited after the fact by someone
// without the whole file. It is not an attestation.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RECEIPT_GENESIS_PREV_HASH, RECEIPT_SCHEMA_ID, firstBrokenLink, receiptHashInput } from "../spec/index.js";
import type { Receipt } from "../spec/index.js";
import type { ReceiptDraft, ReceiptLog } from "../types.js";
import { sha256Hex } from "../intent/hmac.js";

/** Fills schema, seq, prev_hash and hash onto a draft, linking it after `prev`. */
export function sealReceipt(draft: ReceiptDraft, prev: Receipt | null): Receipt {
  const unhashed: Omit<Receipt, "hash"> = {
    ...draft,
    schema: RECEIPT_SCHEMA_ID,
    seq: prev ? prev.seq + 1 : 0,
    prev_hash: prev ? prev.hash : RECEIPT_GENESIS_PREV_HASH,
  };
  return { ...unhashed, hash: `sha256:${sha256Hex(receiptHashInput(unhashed))}` };
}

/** { ok, broken_at } where broken_at is the index of the first bad line. */
export function verifyReceipts(lines: readonly Receipt[]): { ok: boolean; broken_at: number | null } {
  const i = firstBrokenLink(lines, sha256Hex);
  return i === -1 ? { ok: true, broken_at: null } : { ok: false, broken_at: i };
}

/** Serialises appends so seq never forks under concurrent calls. */
function serial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function memoryReceiptLog(): ReceiptLog {
  const lines: Receipt[] = [];
  const queue = serial();
  return {
    append: (draft) =>
      queue(async () => {
        const r = sealReceipt(draft, lines[lines.length - 1] ?? null);
        lines.push(r);
        return JSON.parse(JSON.stringify(r)) as Receipt;
      }),
    read: async () => JSON.parse(JSON.stringify(lines)) as Receipt[],
    verify: async () => verifyReceipts(lines),
  };
}

async function readLines(path: string): Promise<Receipt[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Receipt);
}

/** Appends one JSON line per receipt to `path` (mode 0600). One writer process per file. */
export function fileReceiptLog(path: string): ReceiptLog {
  const queue = serial();
  return {
    append: (draft) =>
      queue(async () => {
        const lines = await readLines(path);
        const r = sealReceipt(draft, lines[lines.length - 1] ?? null);
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, JSON.stringify(r) + "\n", { mode: 0o600 });
        return r;
      }),
    read: () => readLines(path),
    verify: async () => {
      try {
        return verifyReceipts(await readLines(path));
      } catch {
        // An unparseable line is a broken chain; report it at that line.
        const raw = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim() !== "");
        const bad = raw.findIndex((l) => { try { JSON.parse(l); return false; } catch { return true; } });
        return { ok: false, broken_at: bad };
      }
    },
  };
}
