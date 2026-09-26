// INTENT builder. Hash-chained sato.receipt/v1 JSONL.
import type { ReceiptLog } from "../types.js";

export function memoryReceiptLog(): ReceiptLog {
  throw new Error("not implemented: memoryReceiptLog");
}

export function fileReceiptLog(_path: string): ReceiptLog {
  throw new Error("not implemented: fileReceiptLog");
}
