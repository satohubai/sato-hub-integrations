import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOOL_NAMES, INTENT_ID_RE, SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_MAX, TOOL_NAME_MAX, TOOL_NAME_RE,
  approvalHints, buildStatus, coreActions, lintDescription, lintPortableSchema, parsePolicyFile, resolveTool, toolDefinitions,
} from "../src/index.js";

const actions = coreActions();
const def = toolDefinitions({ actions });
const all = toolDefinitions({ actions, toolsets: "all" });

test("default profile is exactly the eight tools, in order", () => {
  assert.deepEqual(def.map((t) => t.name), [...DEFAULT_TOOL_NAMES]);
  assert.equal(def.length, 8);
  assert.deepEqual(toolDefinitions({ actions, toolsets: "default" }).map((t) => t.name), [...DEFAULT_TOOL_NAMES]);
});

test("all adds erc8004_lookup and tx_simulate after the default eight", () => {
  assert.deepEqual(all.map((t) => t.name), [...DEFAULT_TOOL_NAMES, "erc8004_lookup", "tx_simulate", "token_approvals_list", "token_approvals_revoke", "erc8004_register"]);
});

test("every tool passes the portable-schema lint (input and output) and the description lint", () => {
  for (const t of all) {
    assert.deepEqual(lintPortableSchema(t.inputSchema, `${t.name}.input`), [], t.name);
    assert.deepEqual(lintPortableSchema(t.outputSchema, `${t.name}.output`), [], t.name);
    assert.deepEqual(lintDescription(t.description, t.name), [], t.name);
    assert.ok(t.description.length > 0 && t.title.length > 0);
  }
});

test("names are snake_case and at most 40 characters, and unique", () => {
  for (const t of all) {
    assert.ok(TOOL_NAME_RE.test(t.name) && t.name.length <= TOOL_NAME_MAX, t.name);
  }
  assert.equal(new Set(all.map((t) => t.name)).size, all.length);
});

test("execute accepts only intent_id", () => {
  const ex = def.find((t) => t.name === "execute")!;
  assert.equal(ex.kind, "execute");
  assert.equal(ex.oda_id, null);
  const s = ex.inputSchema as any;
  assert.deepEqual(Object.keys(s.properties), ["intent_id"]);
  assert.deepEqual(s.required, ["intent_id"]);
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.intent_id.pattern, INTENT_ID_RE.source);
  assert.equal(ex.annotations.destructiveHint, true);
  assert.equal(ex._meta["anthropic/requiresUserInteraction"], true);
});

test("approval mapping follows effects", () => {
  for (const t of all) {
    const h = approvalHints(t._meta["sato/effects"]);
    assert.equal(t.annotations.readOnlyHint, h.readOnlyHint, t.name);
    assert.equal(t.annotations.idempotentHint, h.idempotentHint, t.name);
    assert.equal(t.annotations.destructiveHint, h.destructiveHint, t.name);
    assert.equal(t._meta["anthropic/requiresUserInteraction"] === true, h.requiresUserInteraction, t.name);
    if (!h.requiresUserInteraction) assert.ok(!("anthropic/requiresUserInteraction" in t._meta), t.name);
  }
  const by = (n: string) => all.find((t) => t.name === n)!;
  for (const n of ["chain_read", "swap_quote", "status", "actions_search", "actions_describe", "erc8004_lookup", "tx_simulate"]) {
    assert.equal(by(n).annotations.readOnlyHint, true, n);
    assert.equal(by(n).annotations.idempotentHint, true, n);
    assert.equal(by(n).annotations.destructiveHint, false, n);
  }
  for (const n of ["swap_prepare", "x402_prepare", "execute"]) {
    assert.equal(by(n).annotations.destructiveHint, true, n);
    assert.equal(by(n)._meta["anthropic/requiresUserInteraction"], true, n);
  }
  assert.equal(by("swap_prepare").kind, "prepare");
  assert.equal(by("chain_read").kind, "read");
  assert.equal(by("status").kind, "meta");
});

test("server instructions fit and carry no banned copy", () => {
  assert.ok(SERVER_INSTRUCTIONS.length <= SERVER_INSTRUCTIONS_MAX, String(SERVER_INSTRUCTIONS.length));
  assert.ok(!/\b(safe|secure|best|guaranteed?|fee-free)\b/i.test(SERVER_INSTRUCTIONS));
  assert.match(SERVER_INSTRUCTIONS, /fork by default/);
  assert.match(SERVER_INSTRUCTIONS, /intent_id/);
  assert.match(SERVER_INSTRUCTIONS, /"direct"/);
});

test("resolveTool takes an ODA id or a tool name", () => {
  assert.equal(resolveTool(all, "swap.prepare")?.name, "swap_prepare");
  assert.equal(resolveTool(all, "swap_prepare")?.oda_id, "swap.prepare");
  assert.equal(resolveTool(all, "erc8004.lookup")?.name, "erc8004_lookup");
  assert.equal(resolveTool(all, "status")?.kind, "meta");
  assert.equal(resolveTool(def, "tx.simulate"), null);
  assert.equal(resolveTool(all, "nope"), null);
});

test("duplicate or meta-colliding action names are refused", () => {
  assert.throws(() => toolDefinitions({ actions: [...actions, actions[0]!] }), /duplicate/);
  const fake = { descriptor: { ...actions[0]!.descriptor, id: "x.status", name: "status" }, run: async () => null } as any;
  assert.throws(() => toolDefinitions({ actions: [fake] }), /collides/);
});

test("buildStatus: unreachable status → unknown, never guessed; red names step and upstream version", () => {
  const p = parsePolicyFile({ schema: "sato.policy/v1", max_usd_per_trade: 50 });
  assert.ok(p.ok);
  const policy = p.ok ? p.policy : (null as never);
  const off = buildStatus({ policy, tools: def, signerKind: null, actionsStatus: null });
  assert.equal(off.status_source, "unreachable");
  assert.equal(off.signer, "none");
  assert.equal(off.network, "fork");
  assert.equal(off.policy.max_usd_per_trade, 50);
  assert.ok(!("max_usd_per_day" in off.policy));
  assert.ok(off.tools.every((t) => t.result === "unknown" && !("last_green" in t)));

  const doc = {
    schema: "sato.action-status/v1",
    updated: "2026-09-26",
    actions: [
      { id: "sato-kit:swap.quote", name: "swap_quote", result: "green", last_green: "2026-09-26" },
      { id: "sato-kit:swap_prepare", name: "swap_prepare", result: "red", failing_step: "simulate", upstream_version: "viem@2.56.9", last_green: "2026-09-20" },
      { id: "agentkit-provider:chain_read", name: "chain_read", result: "green", last_green: "2026-09-26" },
    ],
  };
  const on = buildStatus({ policy, tools: def, signerKind: "viem-local", actionsStatus: doc });
  const row = (n: string) => on.tools.find((t) => t.name === n)!;
  assert.equal(on.status_source, "reachable");
  assert.deepEqual(row("swap_quote"), { name: "swap_quote", result: "green", last_green: "2026-09-26" });
  assert.deepEqual(row("swap_prepare"), { name: "swap_prepare", result: "red", last_green: "2026-09-20", failing_step: "simulate", upstream_version: "viem@2.56.9" });
  assert.equal(row("chain_read").result, "not_listed");
  assert.equal(buildStatus({ policy, tools: def, signerKind: null, actionsStatus: { schema: "other" } }).status_source, "unreachable");
});
