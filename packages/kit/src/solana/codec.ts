// Solana wire codec (Phase 2 wave 2, K4). Dependency-free: base58, the
// compact-u16 ("shortvec") length prefix, program-derived addresses, a LEGACY
// message builder for the few instructions the kit prepares itself (System
// transfer, Associated Token Account create, SPL TransferChecked), and a
// reader that pulls the fee payer and recent blockhash out of any serialized
// transaction (legacy or v0) a venue returns.
//
// Format reference: https://solana.com/docs/core/transactions (message
// header, account ordering, compact arrays) and the program docs for
// the System, Token and Associated Token Account programs.
import { createHash } from "node:crypto";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Wrapped SOL's mint. Jupiter uses it for native SOL. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error(`not base58: ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const c of s) {
    if (c !== "1") break;
    zeros++;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

export const SOLANA_PUBKEY_PATTERN = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";

/** A base58 string that decodes to exactly 32 bytes. */
export function isPubkey(s: unknown): s is string {
  if (typeof s !== "string" || !new RegExp(SOLANA_PUBKEY_PATTERN).test(s)) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

function pubkeyBytes(s: string): Uint8Array {
  const b = base58Decode(s);
  if (b.length !== 32) throw new Error(`not a 32-byte public key: ${s}`);
  return b;
}

// ---- ed25519 on-curve check (for program-derived addresses) ----------------
const P = 2n ** 255n - 19n;
const modp = (a: bigint) => ((a % P) + P) % P;
function powmod(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = modp(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = modp(-121665n * powmod(121666n, P - 2n));

/** True when the 32 bytes decode to a point on ed25519 (so they cannot be a PDA). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  const sign = (bytes[31]! & 0x80) !== 0;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = modp(y2 - 1n);
  const v = modp(D * y2 + 1n);
  const w = (u * powmod(v, P - 2n)) % P;
  if (w === 0n) return !sign;
  return powmod(w, (P - 1n) / 2n) === 1n;
}

/** findProgramAddress: the first bump from 255 down whose hash is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  const program = pubkeyBytes(programId);
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(program);
    h.update(marker);
    const out = new Uint8Array(h.digest());
    if (!isOnCurve(out)) return { address: base58Encode(out), bump };
  }
  throw new Error("no viable bump for program address");
}

/** The associated token account of (owner, mint) under the given token program. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM_ID): string {
  return findProgramAddress([pubkeyBytes(owner), pubkeyBytes(tokenProgram), pubkeyBytes(mint)], ASSOCIATED_TOKEN_PROGRAM_ID).address;
}

// ---- compact-u16 + little-endian helpers ------------------------------------
export function shortvec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    b |= 0x80;
    out.push(b);
  }
}

function readShortvec(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const b = bytes[at + i];
    if (b === undefined) throw new Error("truncated compact-u16");
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value, next: at + i + 1 };
  }
  throw new Error("compact-u16 too long");
}

export function u64le(v: bigint): number[] {
  if (v < 0n || v >= 2n ** 64n) throw new Error("u64 out of range");
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  return out;
}

export function u32le(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

// ---- instructions + legacy message -----------------------------------------
export type AccountMeta = { pubkey: string; isSigner: boolean; isWritable: boolean };
export type Instruction = { programId: string; keys: AccountMeta[]; data: Uint8Array };

export function systemTransferIx(from: string, to: string, lamports: bigint): Instruction {
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }],
    data: Uint8Array.from([...u32le(2), ...u64le(lamports)]),
  };
}

/** Associated Token Account program, instruction 0 (Create): fails if the account already exists. */
export function createAtaIx(payer: string, ata: string, owner: string, mint: string, tokenProgram: string): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(0),
  };
}

/** Token program instruction 12, TransferChecked (same layout in Token-2022). */
export function transferCheckedIx(source: string, mint: string, dest: string, owner: string, amount: bigint, decimals: number, tokenProgram: string): Instruction {
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Uint8Array.from([12, ...u64le(amount), decimals & 0xff]),
  };
}

/**
 * Compiles a LEGACY message and wraps it as an unsigned transaction (every
 * signature slot zero-filled). Account order: fee payer, then writable
 * signers, readonly signers, writable non-signers, readonly non-signers.
 */
export function compileUnsignedLegacyTx(feePayer: string, recentBlockhash: string, ixs: Instruction[]): Uint8Array {
  const metas = new Map<string, { isSigner: boolean; isWritable: boolean }>();
  const touch = (k: string, s: boolean, w: boolean) => {
    const m = metas.get(k) ?? { isSigner: false, isWritable: false };
    metas.set(k, { isSigner: m.isSigner || s, isWritable: m.isWritable || w });
  };
  touch(feePayer, true, true);
  for (const ix of ixs) {
    for (const k of ix.keys) touch(k.pubkey, k.isSigner, k.isWritable);
    touch(ix.programId, false, false);
  }
  const rest = [...metas.entries()].filter(([k]) => k !== feePayer);
  const group = (s: boolean, w: boolean) => rest.filter(([, m]) => m.isSigner === s && m.isWritable === w).map(([k]) => k);
  const keys = [feePayer, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const numSigners = 1 + group(true, true).length + group(true, false).length;
  const header = [numSigners, group(true, false).length, group(false, false).length];
  const idx = new Map(keys.map((k, i) => [k, i]));
  const out: number[] = [...header, ...shortvec(keys.length)];
  for (const k of keys) out.push(...pubkeyBytes(k));
  out.push(...pubkeyBytes(recentBlockhash));
  out.push(...shortvec(ixs.length));
  for (const ix of ixs) {
    out.push(idx.get(ix.programId) as number, ...shortvec(ix.keys.length));
    for (const k of ix.keys) out.push(idx.get(k.pubkey) as number);
    out.push(...shortvec(ix.data.length), ...ix.data);
  }
  return Uint8Array.from([...shortvec(numSigners), ...new Array(64 * numSigners).fill(0), ...out]);
}

export type TxSummary = { version: "legacy" | number; fee_payer: string; recent_blockhash: string; signatures: number; account_keys: string[] };

/** Reads a serialized transaction (legacy or versioned) far enough to name its fee payer and blockhash. */
export function readTransaction(bytes: Uint8Array): TxSummary {
  const sigs = readShortvec(bytes, 0);
  let at = sigs.next + 64 * sigs.value;
  let version: "legacy" | number = "legacy";
  const prefix = bytes[at];
  if (prefix === undefined) throw new Error("truncated transaction");
  if (prefix & 0x80) {
    version = prefix & 0x7f;
    at += 1;
  }
  at += 3; // header
  const n = readShortvec(bytes, at);
  at = n.next;
  const account_keys: string[] = [];
  for (let i = 0; i < n.value; i++, at += 32) {
    if (at + 32 > bytes.length) throw new Error("truncated account keys");
    account_keys.push(base58Encode(bytes.subarray(at, at + 32)));
  }
  if (at + 32 > bytes.length || account_keys.length === 0) throw new Error("truncated transaction");
  return { version, fee_payer: account_keys[0]!, recent_blockhash: base58Encode(bytes.subarray(at, at + 32)), signatures: sigs.value, account_keys };
}

export const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
export const fromBase64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
