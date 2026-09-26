// Vendored verbatim into @satohub/kit (packages/kit/src/spec). Edit here, then re-vendor.
/**
 * Canonical JSON — the one byte form every ODA digest and MAC is computed over.
 *
 * WHY IT EXISTS: an intent_id is an HMAC over a JSON object and a receipt's
 * hash is a sha256 over one. Two implementations that serialise the same
 * object differently would mint different ids for the same intent and break
 * each other's receipt chains. So the byte form is part of the contract.
 *
 * THE RULES (small on purpose, close to RFC 8785 for the values ODA uses):
 *   - object keys sorted by UTF-16 code unit (JavaScript's default sort), recursively;
 *   - arrays keep their order;
 *   - no whitespace;
 *   - strings and numbers as JSON.stringify writes them;
 *   - an object property whose value is `undefined` is omitted, as in JSON;
 *   - a non-finite number, a bigint, a function or a symbol THROWS — a value
 *     JSON cannot carry is a bug upstream, not something to paper over.
 *
 * ODA documents keep amounts as decimal STRINGS, so the float-formatting
 * corner of RFC 8785 never matters here.
 *
 * Pure and dependency-free: no node: imports. Hashing and MACs happen in the
 * kit with node:crypto; this file only decides the bytes they cover.
 */

export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function write(v: unknown, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
    case "boolean":
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) {
        return `[${v.map((x, i) => (x === undefined ? "null" : write(x, `${path}[${i}]`))).join(",")}]`;
      }
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${write(o[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: a ${typeof v} at ${path} cannot be written as JSON`);
  }
}
