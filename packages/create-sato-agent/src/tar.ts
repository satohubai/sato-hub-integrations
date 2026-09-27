// Minimal, dependency-free reader for a gzipped tar (ustar + pax + GNU long
// names), enough for a GitHub codeload tarball. Regular files only; links,
// devices and anything else are skipped.

import { gunzipSync } from "node:zlib";

export interface TarEntry {
  path: string;
  mode: number;
  data: Buffer;
}

function str(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

function octal(buf: Buffer, start: number, len: number): number {
  const s = str(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(data.subarray(i, sp).toString("utf8"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function readTarGz(gz: Uint8Array): TarEntry[] {
  const buf = gunzipSync(gz);
  const entries: TarEntry[] = [];
  let off = 0;
  let pendingName: string | null = null;
  let globalPax: Record<string, string> = {};
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 48);
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (type === "x") {
      const pax = parsePax(data);
      if (pax.path) pendingName = pax.path;
      continue;
    }
    if (type === "g") {
      globalPax = { ...globalPax, ...parsePax(data) };
      continue;
    }
    if (type === "L") {
      pendingName = str(data, 0, data.length);
      continue;
    }
    let name = str(header, 0, 100);
    const prefix = str(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (pendingName) name = pendingName;
    pendingName = null;
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    entries.push({ path: name, mode: octal(header, 100, 8), data: Buffer.from(data) });
  }
  return entries;
}
