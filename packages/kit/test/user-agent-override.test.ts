import { test } from "node:test";
import assert from "node:assert/strict";
import { KIT_USER_AGENT, kitUserAgent } from "../src/version.js";

test("kitUserAgent: default is the registered package UA", () => {
  assert.equal(kitUserAgent({}), KIT_USER_AGENT);
  assert.equal(kitUserAgent({ SATO_USER_AGENT: "  " }), KIT_USER_AGENT);
  assert.equal(kitUserAgent(undefined), KIT_USER_AGENT);
});

test("kitUserAgent: SATO_USER_AGENT is used verbatim", () => {
  assert.equal(kitUserAgent({ SATO_USER_AGENT: "SatoHub-ci/1.0" }), "SatoHub-ci/1.0");
});

test("kitUserAgent: reads process.env by default", () => {
  const prev = process.env.SATO_USER_AGENT;
  try {
    process.env.SATO_USER_AGENT = "SatoHub-ci/2.0";
    assert.equal(kitUserAgent(), "SatoHub-ci/2.0");
    delete process.env.SATO_USER_AGENT;
    assert.equal(kitUserAgent(), KIT_USER_AGENT);
  } finally {
    if (prev === undefined) delete process.env.SATO_USER_AGENT; else process.env.SATO_USER_AGENT = prev;
  }
});
