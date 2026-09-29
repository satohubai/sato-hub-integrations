/** Sato Scan in the signing path: recipient + token pre-flight, transfer sanitising, the hosted call. All offline or on mocked fetch. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  SCAN_DETECTOR_PARAMS,
  SCAN_POLICY_DEFAULTS,
  resolveDetectorParams,
  SatoHubClient,
  resolveScanPolicy,
  canonicalToken,
  checkRecipientHosted,
  claimsFamily,
  lookalikes,
  sanitizeTransfers,
  scanRecipient,
  skeleton,
  type FetchLike,
  type ScanRecipientResult,
} from "../src/index.js";
import { SCAN_CONFUSABLES, SCAN_FAMILY_FORMS, SCAN_PRE_NFKC, SCAN_STABLES, SCAN_TABLE_AS_OF, SCAN_TABLE_SHA256 } from "../src/scanTable.js";

// ── the table ────────────────────────────────────────────────────────────────

test("table: the sha256 of the data equals SCAN_TABLE_SHA256 (same canonical JSON as scripts/gen-core-scan-table.mjs)", () => {
  const data = JSON.stringify({
    as_of: SCAN_TABLE_AS_OF,
    stables: SCAN_STABLES.map((s) => [s[0], s[1], s[2], s[3], s[4]]),
    confusables: SCAN_CONFUSABLES.map((c) => [c[0], c[1]]),
    pre_nfkc: SCAN_PRE_NFKC.map((c) => [c[0], c[1]]),
    family_forms: SCAN_FAMILY_FORMS.map((f) => [f[0], f[1]]),
  });
  assert.equal(createHash("sha256").update(data).digest("hex"), SCAN_TABLE_SHA256);
  assert.match(SCAN_TABLE_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(SCAN_STABLES.length > 0 && SCAN_CONFUSABLES.length > 0);
});

test("table: the pre-NFKC map and the family forms come from the generated table, and fold what they say", () => {
  assert.ok(SCAN_PRE_NFKC.length >= 2 && SCAN_FAMILY_FORMS.length >= 6);
  assert.deepEqual(SCAN_FAMILY_FORMS.map((f) => f[0]).sort(), ["EURC", "PYUSD", "USDC", "USDG", "USDT", "pathUSD"].sort());
  for (const [from, to] of SCAN_PRE_NFKC) {
    // every pre-NFKC key would be rewritten by NFKC into something other than what the map says
    assert.notEqual(from.normalize("NFKC").toUpperCase(), to.toUpperCase());
    assert.equal(skeleton(from), to.toUpperCase());
  }
  for (const [family, source] of SCAN_FAMILY_FORMS) {
    const first = source.replace(/^\^\(/, "").split("|")[0]!;
    assert.equal(claimsFamily(first)?.toLowerCase(), family.toLowerCase(), family);
  }
});

test("table: EVM rows are lowercase 0x + 40 hex, and every row has a known kind", () => {
  for (const [chain, address, , , kind] of SCAN_STABLES) {
    if (chain !== "Solana") assert.match(address, /^0x[0-9a-f]{40}$/, `${chain} ${address}`);
    assert.ok(["issuer", "bridged", "peg"].includes(kind), kind);
  }
});

// ── look-alike parity with lib/scan/lookalike.ts ─────────────────────────────

const BASE_KNOWN = "0xcc1984e79726e7a0ae2b9df2ac9e79fb4983930e";
const BASE_IMITATOR = "0xcc19ea1e6c0f194ad29f8fbb5a1abe7714d2930e";
const POLY_KNOWN = "0x897720c5b19f93f3194990d0121d3a64783bbab8";
const POLY_IMITATOR = "0x8977921b5ba10dddc32bf14c573c9412cc97dab8";

test("parity: the Base pair matches, with the imitated address and both matched ends", () => {
  const hits = lookalikes("Base", BASE_IMITATOR, [{ address: BASE_KNOWN, source: "book" }]);
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0]!.imitates, hits[0]!.prefix, hits[0]!.suffix], [BASE_KNOWN, 4, 4]);
  const r = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN] });
  assert.equal(r.verdict, "no");
  assert.equal(r.rule, "recipient.lookalike");
  assert.equal(r.observed.imitates, BASE_KNOWN);
  assert.equal(r.observed.address, BASE_IMITATOR);
  assert.equal(r.observed.matched_prefix, "cc19");
  assert.equal(r.observed.matched_suffix, "930e");
  assert.match(r.limit, /3 or more/);
});

test("parity: the Polygon hub pair matches at the boundary (4 + 3 = 7)", () => {
  const hits = lookalikes("Polygon", POLY_IMITATOR, [{ address: POLY_KNOWN, source: "book" }]);
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0]!.prefix, hits[0]!.suffix], [4, 3]);
  assert.equal(scanRecipient({ chain: "Polygon", to: POLY_IMITATOR, book: [POLY_KNOWN] }).rule, "recipient.lookalike");
});

test("parity: EVM is compared lowercased after 0x; the same address in another case is the same address, not a look-alike", () => {
  const upper = "0x" + BASE_KNOWN.slice(2).toUpperCase();
  assert.equal(lookalikes("Base", upper, [{ address: BASE_KNOWN, source: "book" }]).length, 0);
  const r = scanRecipient({ chain: "Base", to: upper, book: [BASE_KNOWN] });
  assert.equal(r.verdict, "go");
  // an imitator written in uppercase is still an imitator
  const up2 = "0x" + BASE_IMITATOR.slice(2).toUpperCase();
  assert.equal(scanRecipient({ chain: "Base", to: up2, book: [BASE_KNOWN] }).rule, "recipient.lookalike");
});

test("parity: the rule is both ends >= 3 and 7 together; one end alone or 6 together does not match", () => {
  const known = "0x" + "a".repeat(40);
  const mk = (pre: string, suf: string) => "0x" + pre + "b".repeat(40 - pre.length - suf.length) + suf;
  const hit = (pre: string, suf: string) => lookalikes("Base", mk(pre, suf), [{ address: known, source: "book" }]).length;
  assert.equal(hit("aaaa", "aaa"), 1);
  assert.equal(hit("aaa", "aaaa"), 1);
  assert.equal(hit("aaa", "aaa"), 0, "6 in total");
  assert.equal(hit("aaaaaaaa", ""), 0, "prefix only");
  assert.equal(hit("", "aaaaaaaa"), 0, "suffix only");
  assert.equal(hit("aa", "aaaaa"), 0, "prefix under 3");
});

test("parity: Solana is base58, case-sensitive, and needs both ends", () => {
  const known = "So11111111111111111111111111111111111111112";
  const near = "So11zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz112";
  const hits = lookalikes("Solana", near, [{ address: known, source: "book" }]);
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0]!.prefix, hits[0]!.suffix], [4, 3]);
  const lower = "so11zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz112";
  assert.equal(lookalikes("Solana", lower, [{ address: known, source: "book" }]).length, 0, "the case differs, so the prefix does");
  assert.equal(scanRecipient({ chain: "Solana", to: near, book: [known] }).rule, "recipient.lookalike");
});

test("parity: 1000 random addresses against 50 known ones give 0 matches", () => {
  let seed = 0x5a70;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const addr = () => "0x" + Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
  const known = Array.from({ length: 50 }, () => ({ address: addr(), source: "book" as const }));
  let matches = 0;
  for (let i = 0; i < 1000; i++) matches += lookalikes("Base", addr(), known).length;
  assert.equal(matches, 0);
});

test("in book: a recipient that is exactly in the book but imitates an earlier entry is a caution, never go", () => {
  for (const [chain, known, imitator] of [["Base", BASE_KNOWN, BASE_IMITATOR], ["Polygon", POLY_KNOWN, POLY_IMITATOR]] as const) {
    // both in the book, the imitator recorded later
    const late = scanRecipient({ chain, to: imitator, book: [known, imitator] });
    assert.equal(late.verdict, "caution", chain);
    assert.equal(late.rule, "recipient.lookalike_in_book");
    assert.equal(late.observed.address, imitator);
    assert.equal(late.observed.imitates, known);
    assert.equal(late.observed.imitated_source, "book");
    assert.equal(late.findings.length, 1);
    assert.match(late.limit, /3 or more/);
    // the earlier entry imitates nothing recorded before it: stays go
    const early = scanRecipient({ chain, to: known, book: [known, imitator] });
    assert.equal(early.verdict, "go", chain);
    assert.equal(early.rule, "scan.go");
    assert.equal(early.findings.length, 0);
  }
});

test("in book: the caution holds under policy refuse and caution, is skipped when look-alike is off, and never reads as no", () => {
  const book = [BASE_KNOWN, BASE_IMITATOR];
  assert.equal(scanRecipient({ chain: "Base", to: BASE_IMITATOR, book, policy: { lookalike: "refuse" } }).verdict, "caution");
  assert.equal(scanRecipient({ chain: "Base", to: BASE_IMITATOR, book, policy: { lookalike: "caution" } }).rule, "recipient.lookalike_in_book");
  assert.equal(scanRecipient({ chain: "Base", to: BASE_IMITATOR, book, policy: { lookalike: "off" } }).verdict, "go");
  // an allowed recipient counts as recorded before the book
  const viaAllow = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_IMITATOR], allowRecipients: [BASE_KNOWN] });
  assert.equal(viaAllow.rule, "recipient.lookalike_in_book");
  assert.equal(viaAllow.observed.imitated_source, "allowRecipients");
  // a book of unrelated entries stays go, and a token refusal still outranks the caution
  assert.equal(scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN, ALLOWED] }).verdict, "go");
  const both = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book, token: { address: FOREIGN, symbol: "USDC" } });
  assert.equal(both.verdict, "no");
  assert.deepEqual(both.findings.map((f) => f.rule), ["token.not_canonical", "recipient.lookalike_in_book"]);
});

test("params: undefined, NaN, zero, negative and non-number values fall back to the defaults and never fail open", () => {
  const bad: Partial<Record<string, unknown>>[] = [
    { prefix_min: undefined, suffix_min: undefined, total_min: undefined },
    { prefix_min: NaN, suffix_min: NaN, total_min: NaN },
    { prefix_min: 0, suffix_min: 0, total_min: 0 },
    { prefix_min: -1, suffix_min: -5, total_min: -10 },
    { prefix_min: Infinity, suffix_min: Infinity, total_min: Infinity },
    { prefix_min: "3", suffix_min: null, total_min: true },
    { prefix_min: 0.2, suffix_min: 2.5, total_min: 6.9 },
    { prefix_min: 1e9, suffix_min: 41, total_min: 81 },
  ];
  for (const params of bad) {
    // the Base pair is a look-alike under the defaults, and stays one
    const r = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN], params: params as never });
    assert.equal(r.rule, "recipient.lookalike", JSON.stringify(params));
    assert.equal(lookalikes("Base", BASE_IMITATOR, [{ address: BASE_KNOWN, source: "book" }], params as never).length, 1);
    // a total_min of 0 or a NaN must not turn two unrelated addresses into a match, either
    const ok = scanRecipient({ chain: "Base", to: NEWCOMER, book: [BASE_KNOWN], params: params as never });
    assert.equal(ok.verdict, "unknown", JSON.stringify(params));
  }
  const noted = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN], params: { prefix_min: NaN, total_min: 0 } });
  assert.ok(noted.notes.some((n) => /prefix_min/.test(n) && /default \(3\)/.test(n)));
  assert.ok(noted.notes.some((n) => /total_min/.test(n) && /default \(7\)/.test(n)));
  // a valid override is still honoured, mixed with a bad value that falls back (the Base pair agrees on 4 + 4)
  const stricter = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN], params: { prefix_min: 5, suffix_min: NaN } });
  assert.equal(stricter.verdict, "unknown");
  const same = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN], params: { total_min: 8, suffix_min: NaN } });
  assert.equal(same.rule, "recipient.lookalike");
  assert.deepEqual(resolveDetectorParams("nope").params, SCAN_DETECTOR_PARAMS);
  // fractional and oversized values fall back with a note; the largest legal values are honoured
  const frac = resolveDetectorParams({ prefix_min: 0.2, suffix_min: 1e9 });
  assert.equal(frac.params.prefix_min, 3);
  assert.equal(frac.params.suffix_min, 3);
  assert.equal(frac.notes.length, 2);
  assert.equal(resolveDetectorParams({ prefix_min: 40, total_min: 80, solana_suffix_min: 44 }).notes.length, 0);
});

test("look-alike: allowRecipients is compared too, and Lightning has nothing to compare", () => {
  const r = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [], allowRecipients: [BASE_KNOWN] });
  assert.equal(r.rule, "recipient.lookalike");
  assert.equal(r.observed.imitated_source, "allowRecipients");
  assert.deepEqual(lookalikes("Lightning", "lnbc1abc", [{ address: "lnbc1abd", source: "book" }]), []);
});

test("look-alike: a caller can loosen the numbers, and policy caution / off change the verdict", () => {
  const strict = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN], params: { prefix_min: 5 } });
  assert.notEqual(strict.rule, "recipient.lookalike");
  assert.equal(scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN], policy: { lookalike: "caution" } }).verdict, "caution");
  assert.equal(scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN], policy: { lookalike: "off" } }).verdict, "unknown");
});

// ── the token, by address ────────────────────────────────────────────────────

const baseUsdc = SCAN_STABLES.find((s) => s[0] === "Base" && s[2] === "USDC" && s[4] === "issuer")![1];
const FOREIGN = "0x1111111111111111111111111111111111111111";

test("token: the listed contract passes; the same symbol on another contract is refused by address", () => {
  assert.equal(canonicalToken("Base", baseUsdc)?.family, "USDC");
  const ok = scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN], token: { address: baseUsdc, symbol: "USDC" } });
  assert.equal(ok.verdict, "go");
  const bad = scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN], token: { address: FOREIGN, symbol: "USDC" } });
  assert.equal(bad.verdict, "no");
  assert.equal(bad.rule, "token.not_canonical");
  assert.equal(bad.observed.token, FOREIGN);
  assert.equal(bad.observed.claimed_family, "USDC");
  assert.match(bad.limit, /contract address/);
});

test("token: the caller's stated family wins over a clean-looking symbol, and the symbol never rescues a wrong address", () => {
  const r = scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN], token: { address: FOREIGN, symbol: "XYZ", family: "USDC" } });
  assert.equal(r.rule, "token.not_canonical");
  const r2 = scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN], token: { address: FOREIGN, symbol: "USDC.e" } });
  assert.equal(r2.rule, "token.not_canonical");
});

test("token: a plain address with no label is not refused, and says what it did not compare", () => {
  const r = scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN], token: FOREIGN });
  assert.equal(r.verdict, "go");
  assert.ok(r.notes.some((n) => /not in the table/.test(n)));
});

test("token: a family label on a chain the table does not cover is not checked, and that is said", () => {
  const r = scanRecipient({ chain: "Fantom", to: BASE_KNOWN, book: [BASE_KNOWN], token: { address: FOREIGN, symbol: "USDC" } });
  assert.notEqual(r.rule, "token.not_canonical");
  assert.ok(r.notes.some((n) => /no entry for Fantom/.test(n)));
});

test("token: policy off skips the token check", () => {
  const r = scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN], token: { address: FOREIGN, symbol: "USDC" }, policy: { token: "off" } });
  assert.equal(r.verdict, "go");
});

test("token: a refusal outranks a look-alike and every finding is listed", () => {
  const r = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN], token: { address: FOREIGN, symbol: "USDC" } });
  assert.equal(r.rule, "token.not_canonical");
  assert.deepEqual(r.findings.map((f) => f.rule), ["token.not_canonical", "recipient.lookalike"]);
});

// ── treasury mode ────────────────────────────────────────────────────────────

const ALLOWED = "0x2222222222222222222222222222222222222222";
const NEWCOMER = "0x3333333333333333333333333333333333333333";

test("treasury: an allow-listed recipient is go; one not on the list is refused with its rule", () => {
  const ok = scanRecipient({ chain: "Base", to: ALLOWED, book: [], allowRecipients: [ALLOWED], treasury: true });
  assert.equal(ok.verdict, "go");
  const no = scanRecipient({ chain: "Base", to: NEWCOMER, book: [], allowRecipients: [ALLOWED], treasury: true });
  assert.equal(no.verdict, "no");
  assert.equal(no.rule, "recipient.not_allowlisted");
  assert.match(no.limit, /allow_recipients/);
});

test("treasury: outside treasury mode, a new address that imitates nothing is unknown, not refused, with a note", () => {
  const r = scanRecipient({ chain: "Base", to: NEWCOMER, book: [ALLOWED], allowRecipients: [ALLOWED] });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.rule, "scan.unknown");
  assert.ok(r.notes.some((n) => /holds no record/.test(n)));
  assert.equal(scanRecipient({ chain: "Base", to: NEWCOMER, book: [], allowRecipients: [ALLOWED], treasury: true, policy: { treasury_recipients: "off" } }).verdict, "unknown");
});

test("treasury: a look-alike of an allowed recipient is refused as a look-alike first", () => {
  const r = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [], allowRecipients: [BASE_KNOWN], treasury: true });
  assert.equal(r.rule, "recipient.lookalike");
  assert.deepEqual(r.findings.map((f) => f.rule), ["recipient.lookalike", "recipient.not_allowlisted"]);
});

test("malformed: a recipient that is not an address of the chain is unknown and compared with nothing", () => {
  const r = scanRecipient({ chain: "Base", to: "0x1234", book: [BASE_KNOWN] });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.rule, "recipient.malformed");
});

test("defaults: SCAN_POLICY_DEFAULTS is the strict block the generated policy.json carries", () => {
  assert.deepEqual({ ...SCAN_POLICY_DEFAULTS }, {
    lookalike: "refuse",
    token: "refuse_not_canonical",
    payto_changed: "caution",
    treasury_recipients: "allowlist_only",
    hosted_check: false,
  });
});

// ── chain-qualified policy entries (the form allow_recipients really has) ────

const QUAL_ALLOWED = `base:${ALLOWED}`;
const QUAL_KNOWN = `base:${BASE_KNOWN}`;

test("qualified: `base:0x..` from allow_recipients matches exactly in treasury mode", () => {
  const ok = scanRecipient({ chain: "Base", to: ALLOWED, book: [], allowRecipients: [QUAL_ALLOWED], treasury: true });
  assert.equal(ok.verdict, "go");
  const upper = scanRecipient({ chain: "base", to: ALLOWED.toUpperCase().replace("0X", "0x"), book: [], allowRecipients: [`Base:${ALLOWED}`], treasury: true });
  assert.equal(upper.verdict, "go", "the chain name and the hex case do not matter");
  const no = scanRecipient({ chain: "Base", to: NEWCOMER, book: [], allowRecipients: [QUAL_ALLOWED], treasury: true });
  assert.equal(no.rule, "recipient.not_allowlisted");
});

test("qualified: a look-alike of a qualified entry is flagged, naming the bare address it imitates", () => {
  const r = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [], allowRecipients: [QUAL_KNOWN] });
  assert.equal(r.verdict, "no");
  assert.equal(r.rule, "recipient.lookalike");
  assert.equal(r.observed.imitates, BASE_KNOWN);
  assert.equal(r.observed.imitated_source, "allowRecipients");
});

test("qualified: an entry for another chain is ignored, counted in the notes, and never allows the address", () => {
  const other = scanRecipient({ chain: "Base", to: ALLOWED, book: [], allowRecipients: [`polygon:${ALLOWED}`], treasury: true });
  assert.equal(other.verdict, "no");
  assert.equal(other.rule, "recipient.not_allowlisted");
  assert.ok(other.notes.some((n) => /another chain/.test(n)));
  const lookalikeOther = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [], allowRecipients: [`polygon:${BASE_KNOWN}`] });
  assert.equal(lookalikeOther.rule, "scan.unknown", "a Polygon entry is not a Base look-alike target");
  const sol = scanRecipient({ chain: "Solana", to: "So11111111111111111111111111111111111111112", book: [], allowRecipients: [`base:${ALLOWED}`], treasury: true });
  assert.equal(sol.rule, "recipient.not_allowlisted");
});

test("qualified: the book takes the same forms, and a raw address still applies to the chain asked about", () => {
  const book = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [QUAL_KNOWN] });
  assert.equal(book.rule, "recipient.lookalike");
  assert.equal(book.observed.imitated_source, "book");
  assert.equal(scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [QUAL_KNOWN] }).verdict, "go");
  assert.equal(scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [`polygon:${BASE_KNOWN}`] }).rule, "scan.unknown");
  assert.equal(scanRecipient({ chain: "Base", to: ALLOWED, book: [], allowRecipients: [ALLOWED], treasury: true }).verdict, "go");
});

// ── policy values: a bad one falls back to the default, never to off ─────────

test("policy: undefined, misspelt or wrong-typed values use the default for that field and say so", () => {
  const r = resolveScanPolicy({ lookalike: undefined, token: "refuse-not-canonical", payto_changed: 3, treasury_recipients: null, hosted_check: "yes" });
  assert.deepEqual(r.policy, { ...SCAN_POLICY_DEFAULTS });
  assert.equal(r.notes.length, 4, "undefined is simply absent; the other four are named");
  assert.deepEqual(resolveScanPolicy(undefined).policy, { ...SCAN_POLICY_DEFAULTS });
  assert.deepEqual(resolveScanPolicy("off").policy, { ...SCAN_POLICY_DEFAULTS });
  assert.deepEqual(resolveScanPolicy({ lookalike: "caution", hosted_check: true }).policy, { ...SCAN_POLICY_DEFAULTS, lookalike: "caution", hosted_check: true });
});

test("policy: `{ lookalike: undefined }` and an invalid enum still refuse a look-alike and a fake token", () => {
  for (const policy of [{ lookalike: undefined }, { lookalike: "Off" }, { lookalike: "none" }, { lookalike: false }] as never[]) {
    const r = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN], policy });
    assert.equal(r.verdict, "no", JSON.stringify(policy));
    assert.equal(r.rule, "recipient.lookalike");
  }
  const t = scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN], token: { address: FOREIGN, symbol: "USDC" }, policy: { token: "disabled" } as never });
  assert.equal(t.rule, "token.not_canonical");
  assert.ok(t.notes.some((n) => /scan\.token was not one of/.test(n)));
  const noTreasury = scanRecipient({ chain: "Base", to: NEWCOMER, book: [], allowRecipients: [ALLOWED], treasury: true, policy: { treasury_recipients: "sometimes" } as never });
  assert.equal(noTreasury.rule, "recipient.not_allowlisted");
});

test("policy: the reserved and caller-side fields change nothing scanRecipient decides", () => {
  const base = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN] });
  for (const policy of [{ payto_changed: "off" }, { payto_changed: "refuse" }, { hosted_check: true }] as const) {
    const r = scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN], policy });
    assert.deepEqual([r.verdict, r.rule], [base.verdict, base.rule]);
  }
});

// ── the skeleton and sanitizeTransfers ───────────────────────────────────────

// U+10BD Georgian letter, U+A4DA Lisu letter: each looks like a Latin letter and folds to it.
const GEORGIAN_S = "Ⴝ";
const LISU_C = "ꓚ";

test("skeleton: look-alike letters, zero-width characters and fullwidth forms fold to the plain label", () => {
  assert.equal(skeleton("USDC"), "USDC");
  assert.equal(claimsFamily(`U${GEORGIAN_S}D${LISU_C}`), "USDC");
  assert.equal(claimsFamily("USD​C"), "USDC");
  assert.equal(claimsFamily("ＵＳＤＣ"), "USDC");
  assert.equal(claimsFamily("USDϹ"), "USDC");
  assert.equal(claimsFamily("USD Coin (Bridged)"), "USDC");
  assert.equal(claimsFamily("Tether USD"), "USDT");
  assert.equal(claimsFamily("PEPE"), null);
  assert.equal(claimsFamily("USDCASH"), null, "a longer word is not a family");
  assert.equal(claimsFamily(null, "Circle USDC"), "USDC", "the name is read when the symbol says nothing");
});

test("sanitizeTransfers: rows whose contract is not canonical but whose label claims a stablecoin are removed, with a count note", () => {
  const rows = [
    { hash: "1", tokenAddress: baseUsdc, symbol: "USDC" },
    { hash: "2", tokenAddress: FOREIGN, symbol: `U${GEORGIAN_S}D${LISU_C}` },
    { hash: "3", tokenAddress: FOREIGN, symbol: "USDC" },
    { hash: "4", tokenAddress: "0x4444444444444444444444444444444444444444", symbol: "PEPE" },
    { hash: "5", symbol: "ETH" },
    { hash: "6", tokenAddress: FOREIGN, symbol: "X", name: "USD Coin" },
  ];
  const out = sanitizeTransfers(rows, { chain: "Base" });
  assert.deepEqual(out.rows.map((r) => r.hash), ["1", "4", "5"]);
  assert.deepEqual(out.removed.map((r) => r.hash), ["2", "3", "6"]);
  assert.deepEqual(out.notes, ["3 rows removed: tokens imitating USDC"]);
});

test("sanitizeTransfers: one row reads as singular, a custom reader is honoured, and an uncovered chain is kept and said", () => {
  const one = sanitizeTransfers([{ c: FOREIGN, s: "USDT" }], { chain: "Base", read: (r) => ({ address: r.c, symbol: r.s }) });
  assert.equal(one.rows.length, 0);
  assert.deepEqual(one.notes, ["1 row removed: token imitating USDT"]);
  const uncovered = sanitizeTransfers([{ token_address: FOREIGN, symbol: "USDC" }], { chain: "Fantom" });
  assert.equal(uncovered.rows.length, 1);
  assert.equal(uncovered.removed.length, 0);
  assert.match(uncovered.notes[0]!, /not covered|does not cover/);
  assert.deepEqual(sanitizeTransfers([], { chain: "Base" }), { rows: [], removed: [], unchecked: [], notes: [] });
});

test("sanitizeTransfers: `token` and `contract` are read only when address-shaped for the chain; a bare `address` is never read", () => {
  // a nested object, a symbol string and a wallet-less label are not addresses
  const rows = [
    { hash: "1", token: { symbol: "USDC" }, symbol: "USDC" },
    { hash: "2", token: "USDC", symbol: "USDC" },
    { hash: "3", contract: FOREIGN, symbol: "USDC" },
    { hash: "4", address: baseUsdc, symbol: "USDC" },
    { hash: "5", token: "not an address", symbol: "PEPE" },
  ];
  const out = sanitizeTransfers(rows, { chain: "Base" });
  assert.deepEqual(out.removed.map((r) => r.hash), ["3"], "a shaped, foreign contract is removed");
  assert.deepEqual(out.unchecked.map((r) => r.hash), ["1", "2", "4"], "no readable token field: kept, returned as unchecked");
  assert.deepEqual(out.rows.map((r) => r.hash), ["1", "2", "4", "5"]);
  assert.deepEqual(out.notes, ["1 row removed: token imitating USDC", "3 rows carry a stablecoin label but no readable token address; kept, not checked"]);
  const solana = sanitizeTransfers([{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" }, { token: "0x1234", symbol: "USDC" }], { chain: "Solana" });
  assert.deepEqual([solana.removed.length, solana.unchecked.length, solana.rows.length], [0, 1, 2]);
});

test("sanitizeTransfers: a row's `address` (a holder or counterparty wallet) is never taken as the token contract", () => {
  // the wallet address is foreign to the table; reading it as the token would wrongly remove a genuine USDC row
  const wallet = "0x1111111111111111111111111111111111111111";
  const genuine = { hash: "g", address: wallet, token_address: baseUsdc, symbol: "USDC" };
  const noTokenField = { hash: "n", address: wallet, symbol: "USDC" };
  const imitation = { hash: "i", address: baseUsdc, token: FOREIGN, symbol: "USDC" };
  const out = sanitizeTransfers([genuine, noTokenField, imitation], { chain: "Base" });
  assert.deepEqual(out.rows.map((r) => r.hash), ["g", "n"], "genuine kept; a row with no token field is untouched");
  assert.deepEqual(out.removed.map((r) => r.hash), ["i"], "the explicit token field decides, not the row's address");
  assert.deepEqual(out.unchecked.map((r) => r.hash), ["n"]);
  // a row with only `address` and no stablecoin label is just kept
  assert.equal(sanitizeTransfers([{ address: FOREIGN, symbol: "ETH" }], { chain: "Base" }).rows.length, 1);
  // and a canonical address in `address` never rescues a row whose token field is foreign
  assert.equal(sanitizeTransfers([{ address: baseUsdc, contractAddress: FOREIGN, symbol: "USDC" }], { chain: "Base" }).removed.length, 1);
});

test("sanitizeTransfers: a custom reader that returns something that is not an address is unchecked, not compared", () => {
  const out = sanitizeTransfers([{ id: "x" }], { chain: "Base", read: () => ({ address: "USDC", symbol: "USDC" }) });
  assert.equal(out.removed.length, 0);
  assert.equal(out.unchecked.length, 1);
  assert.match(out.notes[0]!, /no readable token address/);
});

// ── the hosted call ──────────────────────────────────────────────────────────

const reading = {
  schema: "sato.scan.recipient/v1",
  verdict: "caution",
  rule: "S3",
  reason: "The address was seen in a burst of dust transfers.",
  limits: { notes: ["window 30 days"] },
  as_of: "2026-09-28T00:00:00.000Z",
};

function mock(handler: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>) {
  const calls: { url: string; body: unknown; ua: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, ua: headers.get("user-agent") ?? "" });
    return handler(url, init, calls.length);
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("hosted: sends only chain, to and token by default, even when from, origin and amount are on the input", async () => {
  const m = mock(() => json(reading));
  const r = await checkRecipientHosted(
    { chain: "Base", to: BASE_KNOWN, token: baseUsdc, amount: "1000000", from: NEWCOMER, origin: "https://api.example.test/pay" },
    { fetch: m.fetch, verify: false },
  );
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0]!.url, /\/api\/scan\/recipient$/);
  assert.deepEqual(m.calls[0]!.body, { chain: "Base", to: BASE_KNOWN, token: baseUsdc });
  assert.match(m.calls[0]!.ua, /satohub-core-client/);
  assert.equal(r.verdict, "caution");
  assert.equal(r.rule, "S3");
  assert.equal(r.error, undefined);
  assert.equal(r.reading?.schema, "sato.scan.recipient/v1");
});

test("hosted: from, origin and amount are sent only when named in include, and empty values are still dropped", async () => {
  const input = { chain: "Base", to: BASE_KNOWN, token: baseUsdc, amount: "1000000", from: NEWCOMER, origin: "" };
  const a = mock(() => json(reading));
  await checkRecipientHosted(input, { fetch: a.fetch, verify: false, include: ["amount"] });
  assert.deepEqual(a.calls[0]!.body, { chain: "Base", to: BASE_KNOWN, token: baseUsdc, amount: "1000000" });
  const b = mock(() => json(reading));
  await checkRecipientHosted(input, { fetch: b.fetch, verify: false, include: ["from", "origin", "amount"] });
  assert.deepEqual(b.calls[0]!.body, { chain: "Base", to: BASE_KNOWN, token: baseUsdc, amount: "1000000", from: NEWCOMER });
  // an unknown name in include opens nothing
  const c = mock(() => json(reading));
  await checkRecipientHosted({ ...input, origin: "https://x.test" }, { fetch: c.fetch, verify: false, include: ["nonsense" as never] });
  assert.deepEqual(c.calls[0]!.body, { chain: "Base", to: BASE_KNOWN, token: baseUsdc });
});

test("hosted: SatoHubClient.checkRecipient applies the same rule, and a custom client is handed only the opted-in fields", async () => {
  const m = mock(() => json(reading));
  const client = new SatoHubClient({ fetch: m.fetch, verify: false });
  await client.checkRecipient({ chain: "Base", to: BASE_KNOWN, from: NEWCOMER, amount: "5", origin: "https://x.test" });
  assert.deepEqual(m.calls[0]!.body, { chain: "Base", to: BASE_KNOWN });
  await client.checkRecipient({ chain: "Base", to: BASE_KNOWN, from: NEWCOMER, amount: "5" }, { include: ["from"] });
  assert.deepEqual(m.calls[1]!.body, { chain: "Base", to: BASE_KNOWN, from: NEWCOMER });

  const seen: unknown[] = [];
  const custom = {
    async checkRecipient(input: unknown) {
      seen.push(input);
      return { data: reading, signature: null } as never;
    },
  };
  await checkRecipientHosted({ chain: "Base", to: BASE_KNOWN, from: NEWCOMER, amount: "5", origin: "https://x.test" }, { client: custom });
  assert.deepEqual(seen[0], { chain: "Base", to: BASE_KNOWN });
});

test("hosted: fails open. A network error is unknown with the error, and is retried once", async () => {
  const m = mock(() => {
    throw new Error("connect ECONNREFUSED");
  });
  const r = await checkRecipientHosted({ chain: "Base", to: BASE_KNOWN }, { fetch: m.fetch, verify: false });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.reading, null);
  assert.match(r.error ?? "", /ECONNREFUSED/);
  assert.match(r.reason, /not a finding about the recipient/);
  assert.equal(m.calls.length, 2);
});

test("hosted: a 5xx is unknown and retried; a 4xx is unknown and never retried", async () => {
  const five = mock(() => json({ error: "boom" }, 503));
  const r5 = await checkRecipientHosted({ chain: "Base", to: BASE_KNOWN }, { fetch: five.fetch, verify: false });
  assert.equal(r5.verdict, "unknown");
  assert.equal(r5.status, 503);
  assert.equal(five.calls.length, 2);

  for (const status of [400, 402, 404, 429]) {
    const four = mock(() => json({ error: "no" }, status));
    const r4 = await checkRecipientHosted({ chain: "Base", to: BASE_KNOWN }, { fetch: four.fetch, verify: false, retries: 3 });
    assert.equal(r4.verdict, "unknown", String(status));
    assert.equal(r4.status, status);
    assert.equal(four.calls.length, 1, `no retry on ${status}`);
  }
});

test("hosted: a 5xx that recovers on the retry returns the reading", async () => {
  const m = mock((_u, _i, n) => (n === 1 ? json({}, 502) : json(reading)));
  const r = await checkRecipientHosted({ chain: "Base", to: BASE_KNOWN }, { fetch: m.fetch, verify: false });
  assert.equal(r.verdict, "caution");
  assert.equal(m.calls.length, 2);
});

test("hosted: retries: 0 means one attempt; a body that is not a reading is unknown; missing input never calls out", async () => {
  const m = mock(() => json({ hello: "world" }));
  const r = await checkRecipientHosted({ chain: "Base", to: BASE_KNOWN }, { fetch: m.fetch, verify: false, retries: 0 });
  assert.equal(r.verdict, "unknown");
  assert.match(r.error ?? "", /not a recipient reading/);
  assert.equal(m.calls.length, 1);
  const none = await checkRecipientHosted({ chain: "", to: "" }, { fetch: m.fetch, verify: false });
  assert.equal(none.verdict, "unknown");
  assert.equal(m.calls.length, 1);
});

test("hosted: an existing client can be passed in", async () => {
  const m = mock(() => json(reading));
  const client = new SatoHubClient({ fetch: m.fetch, verify: false, baseUrl: "https://example.test" });
  const r = await checkRecipientHosted({ chain: "Base", to: BASE_KNOWN }, { client });
  assert.equal(r.verdict, "caution");
  assert.equal(m.calls[0]!.url, "https://example.test/api/scan/recipient");
});

// ── wording ──────────────────────────────────────────────────────────────────

test("wording: nothing a reading says uses a banned word, and no-record is never called safe", () => {
  const banned = /\b(scam|fraud|wash|fake volume|malicious|safe|secure|verified|clean|trusted|guaranteed)\b/i;
  const results: ScanRecipientResult[] = [
    scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN] }),
    scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN], token: { address: FOREIGN, symbol: "USDC" } }),
    scanRecipient({ chain: "Base", to: NEWCOMER, book: [ALLOWED], allowRecipients: [ALLOWED], treasury: true }),
    scanRecipient({ chain: "Base", to: NEWCOMER, book: [ALLOWED] }),
    scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN] }),
    scanRecipient({ chain: "Base", to: "nope", book: [] }),
    scanRecipient({ chain: "Base", to: BASE_IMITATOR, book: [BASE_KNOWN, BASE_IMITATOR] }),
    scanRecipient({ chain: "Base", to: BASE_KNOWN, book: [BASE_KNOWN], params: { total_min: NaN } }),
    scanRecipient({ chain: "Solana", to: "So11zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz112", book: ["So11111111111111111111111111111111111111112"] }),
  ];
  for (const r of results) {
    const text = [r.reason, r.limit, ...r.notes, ...r.findings.flatMap((f) => [f.reason, f.limit])].join("\n");
    assert.ok(!banned.test(text), text);
  }
  const unknown = scanRecipient({ chain: "Base", to: NEWCOMER, book: [ALLOWED] });
  assert.equal(unknown.verdict, "unknown");
  assert.ok(!/\bgo\b/.test(unknown.verdict));
});
