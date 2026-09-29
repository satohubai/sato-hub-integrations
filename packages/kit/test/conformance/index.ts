// ONE table of conformance cases, run through every door. Each door supplies a
// ConformanceRunner; runConformance(runner) registers the whole table under
// node:test. Doors: the kit's local MCP server and the AI SDK, AgentKit,
// Claude Agent SDK, OpenAI Agents SDK, elizaOS and LangChain subpaths (test/adapters.conformance.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TOOL_NAMES, INTENT_ID_RE } from "../../src/index.js";
import type { ToolEnvelope } from "../../src/adapters/_dispatch.js";
import type { Kit } from "../../src/types.js";
import type { SatoPolicy } from "../../src/spec/index.js";
import { FORK_BLOCK, fixtureKit } from "./fixture-kit.js";

export type RunnerInstance = {
  /** Tool names as the host sees them (without any host prefix). */
  listTools(): Promise<string[]>;
  /** Calls a tool as the host would AFTER a person approved it (when approval applies). */
  call(name: string, args: unknown): Promise<ToolEnvelope>;
  /** Asks the host's own approval mechanism whether this call needs a person. */
  approvalRequired(name: string, args: unknown): Promise<boolean>;
  /**
   * Calls a tool with the host's approval DENIED (or absent) and returns what happened,
   * or null when the host stops the call before it reaches the tool (the envelope is never produced).
   */
  callUnapproved(name: string, args: unknown): Promise<ToolEnvelope | null>;
  close?(): Promise<void>;
};

export type ConformanceRunner = {
  name: string;
  /** null = run; a string = skip with this reason. */
  skip?: string | null;
  create(kit: Kit, policy: SatoPolicy): Promise<RunnerInstance>;
};

type Ctx = Awaited<ReturnType<typeof fixtureKit>> & { r: RunnerInstance };

type Case = { name: string; policy?: Record<string, unknown>; run(c: Ctx): Promise<void> };

export const CASES: Case[] = [
  {
    name: "lists exactly the default eight tools, in order",
    async run({ r }) {
      assert.deepEqual(await r.listTools(), [...DEFAULT_TOOL_NAMES]);
    },
  },
  {
    name: "chain_read reads from the fixture RPC",
    async run({ r }) {
      const env = await r.call("chain_read", { kind: "block_number", chain: "base" });
      assert.equal(env.ok, true, JSON.stringify(env));
      const res = (env as { result: { block_number: string; kind: string } }).result;
      assert.equal(res.kind, "block_number");
      assert.equal(res.block_number, String(FORK_BLOCK));
    },
  },
  {
    name: "swap_prepare over the cap is refused with rule, limit and observed",
    policy: { max_slippage_bps: 10 },
    async run({ r, swapInput, sent }) {
      const env = await r.call("swap_prepare", swapInput);
      assert.equal(env.ok, false, JSON.stringify(env));
      if (env.ok) return;
      assert.equal(env.error.code, "policy_refused");
      const ref = env.error.refusals?.find((x) => x.rule === "max_slippage_bps");
      assert.ok(ref, JSON.stringify(env.error));
      assert.equal(ref!.limit, "10");
      assert.equal(ref!.observed, "50");
      assert.equal(sent.length, 0);
    },
  },
  {
    name: "execute of a refused intent is refused naming rule, limit and observed, and sends nothing",
    policy: { max_slippage_bps: 10 },
    async run({ r, swapInput, sent }) {
      const prep = await r.call("swap_prepare", swapInput);
      assert.equal(prep.ok, false, JSON.stringify(prep));
      const intent_id = prep.ok ? null : (prep.intent as { intent_id?: string } | undefined)?.intent_id;
      if (!intent_id) return; // this door returns no intent for a refused prepare, so there is nothing to execute
      const env = await r.call("execute", { intent_id });
      assert.equal(env.ok, false, JSON.stringify(env));
      if (env.ok) return;
      assert.equal(env.error.code, "policy_refused", JSON.stringify(env.error));
      const ref = env.error.refusals?.find((x) => x.rule === "max_slippage_bps");
      assert.ok(ref, JSON.stringify(env.error));
      assert.equal(ref!.limit, "10");
      assert.equal(ref!.observed, "50");
      assert.equal(sent.length, 0);
    },
  },
  {
    name: "swap_prepare within the cap returns an intent",
    async run({ r, swapInput, sent }) {
      const env = await r.call("swap_prepare", swapInput);
      assert.equal(env.ok, true, JSON.stringify(env));
      const intent = (env as { result: { intent_id: string; policy: { ok: boolean } } }).result;
      assert.match(intent.intent_id, INTENT_ID_RE);
      assert.equal(intent.policy.ok, true);
      assert.equal(sent.length, 0, "prepare sends nothing");
    },
  },
  {
    name: "execute with an extra argument is rejected and sends nothing",
    async run({ r, swapInput, sent }) {
      const prep = await r.call("swap_prepare", swapInput);
      assert.equal(prep.ok, true);
      const intent_id = (prep as { result: { intent_id: string } }).result.intent_id;
      const env = await r.call("execute", { intent_id, to: "0x000000000000000000000000000000000000dEaD" });
      assert.equal(env.ok, false, JSON.stringify(env));
      if (!env.ok) assert.equal(env.error.code, "invalid_input");
      assert.equal(sent.length, 0);
    },
  },
  {
    name: "execute requires approval through the host's own mechanism; read tools do not",
    async run({ r, swapInput, sent }) {
      const prep = await r.call("swap_prepare", swapInput);
      const intent_id = (prep as { result: { intent_id: string } }).result.intent_id;
      assert.equal(await r.approvalRequired("execute", { intent_id }), true);
      assert.equal(await r.approvalRequired("chain_read", { kind: "block_number", chain: "base" }), false);
      const denied = await r.callUnapproved("execute", { intent_id });
      if (denied !== null) {
        assert.equal(denied.ok, false, JSON.stringify(denied));
        if (!denied.ok) assert.ok(["approval_required", "approval_denied"].includes(denied.error.code), denied.error.code);
      }
      assert.equal(sent.length, 0, "an unapproved execute sends nothing");
      const done = await r.call("execute", { intent_id });
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal((done as { result: { status: string } }).result.status, "executed");
      assert.equal(sent.length, 1);
    },
  },
];

export function runConformance(runner: ConformanceRunner): void {
  for (const c of CASES) {
    test(`conformance [${runner.name}]: ${c.name}`, { skip: runner.skip ?? false }, async () => {
      const fk = await fixtureKit(c.policy ?? {});
      const r = await runner.create(fk.kit, fk.policy);
      try {
        await c.run({ ...fk, r });
      } finally {
        await r.close?.();
      }
    });
  }
}
