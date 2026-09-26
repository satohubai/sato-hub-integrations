import { test } from "node:test";
import assert from "node:assert/strict";
import * as root from "../src/index.js";
import * as spec from "../src/spec/index.js";
import * as policy from "../src/policy/index.js";
import * as signers from "../src/signers/index.js";
import * as intent from "../src/intent/index.js";
import * as receipts from "../src/receipts/index.js";
import * as actions from "../src/actions/index.js";
import { KIT_USER_AGENT, KIT_VERSION } from "../src/version.js";

test("user agent shape", () => {
  assert.equal(KIT_VERSION, "0.1.0");
  assert.equal(KIT_USER_AGENT, "@satohub/kit/0.1.0");
  assert.match(KIT_USER_AGENT, /^@satohub\/kit\/\d+\.\d+\.\d+$/);
});

test("every module loads and exports its final names", () => {
  assert.equal(spec.ACTION_SCHEMA_ID, "sato.action/v1");
  for (const f of [policy.evaluatePreflight, policy.compileCdpPolicy, signers.viemLocalSigner, signers.owsSigner,
    signers.cdpSigner, intent.memoryIntentStore, intent.fileIntentStore, intent.computeIntentId, receipts.memoryReceiptLog,
    receipts.fileReceiptLog, actions.coreActions, root.createKit]) assert.equal(typeof f, "function");
  assert.equal(typeof actions.CORE_ACTIONS.list, "function");
  assert.equal(root.KIT_USER_AGENT, KIT_USER_AGENT);
});
