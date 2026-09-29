import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { CORE_ACTIONS, coreActions } from "../src/actions/index.js";
import {
  EXACT_VERSION_RE, lintActionDescriptor, lintPortableSchema, odaIdToToolName, toolNameToOdaId, validateActionDescriptor,
} from "../src/spec/index.js";
import { PKG_ROOT } from "./fixtures/actions-harness.js";

const EXPECTED_IDS = ["chain.read", "swap.quote", "swap.prepare", "x402.prepare", "erc8004.lookup", "tx.simulate", "token.approvals.list", "token.approvals.revoke", "erc8004.register", "bridge.quote", "bridge.prepare", "solana.read", "solana.transfer", "solana.swap.quote", "solana.swap.prepare"];

test("CORE_ACTIONS lists the core set in a stable order", () => {
  assert.deepEqual(CORE_ACTIONS.list().map((a) => a.descriptor.id), EXPECTED_IDS);
  assert.deepEqual(coreActions().map((a) => a.descriptor.id), EXPECTED_IDS);
});

for (const action of coreActions()) {
  const d = action.descriptor;
  test(`${d.id}: lint, portable schemas and validation are clean`, () => {
    assert.deepEqual(lintActionDescriptor(d as never), []);
    assert.deepEqual(lintPortableSchema(d.input_schema, "input_schema"), []);
    assert.deepEqual(lintPortableSchema(d.output_schema, "output_schema"), []);
    const v = validateActionDescriptor(d);
    assert.equal(v.ok, true, v.ok ? "" : v.errors.join("; "));
  });

  test(`${d.id}: custody, pins and fixtures are honest`, () => {
    assert.equal(d.custody.reads_key, false);
    assert.equal(d.custody.sends_key, false);
    const isPrepare = "build" in action;
    assert.equal(d.custody.moves_funds, isPrepare ? "with_approval" : "never");
    assert.equal(d.receipt, isPrepare);
    assert.equal(d.sponsored, null);
    for (const v of Object.values(d.upstream)) assert.match(v, EXACT_VERSION_RE);
    for (const f of d.fixtures) assert.ok(existsSync(join(PKG_ROOT, f)), `fixture ${f} exists`);
  });
}

test("names map deterministically both ways", () => {
  const a = coreActions().map((x) => x.descriptor);
  const b = coreActions().map((x) => x.descriptor);
  assert.deepEqual(a.map((d) => d.name), b.map((d) => d.name));
  assert.deepEqual(a.map((d) => d.name), ["chain_read", "swap_quote", "swap_prepare", "x402_prepare", "erc8004_lookup", "tx_simulate", "token_approvals_list", "token_approvals_revoke", "erc8004_register", "bridge_quote", "bridge_prepare", "solana_read", "solana_transfer", "solana_swap_quote", "solana_swap_prepare"]);
  const ids = a.map((d) => d.id);
  for (const d of a) {
    assert.equal(d.name, odaIdToToolName(d.id));
    assert.equal(toolNameToOdaId(d.name, ids), d.id);
    // Without the known ids only a two-segment name is unambiguous (spec/names.ts); deeper ids need knownIds.
    assert.equal(toolNameToOdaId(d.name), d.id.split(".").length === 2 ? d.id : null);
  }
});

function stringLiterals(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text);
      for (const s of n.templateSpans) out.push(s.literal.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("no string literal in src/actions says best or recommended", () => {
  const dir = join(PKG_ROOT, "src", "actions");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 7);
  for (const f of files) {
    for (const s of stringLiterals(join(dir, f))) {
      assert.doesNotMatch(s, /\bbest\b|recommended/i, `${f}: ${JSON.stringify(s)}`);
      assert.doesNotMatch(s, /\b(safe|secure|guaranteed|fee-free)\b/i, `${f}: ${JSON.stringify(s)}`);
    }
  }
});
