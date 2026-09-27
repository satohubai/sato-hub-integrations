// Packaging manifests: every install surface pins the same major.minor as the
// package, never "latest", and names the same server. Reads files only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Compiled to .test-build/test/*.js -> package root is two levels up.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const json = (p: string) => JSON.parse(read(p)) as any;

const PKG = json("package.json");
const MM = (PKG.version as string).split(".").slice(0, 2).join(".");
const SPEC = `@satohub/kit@${MM}`;
const FILES = ["server.json", ".mcp.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "gemini-extension.json", "context7.json", "llms-install.md", "skill/SKILL.md"];

test("every packaging file exists", () => {
  for (const f of FILES) assert.ok(existsSync(join(ROOT, f)), f);
});

test("no manifest ever says latest; every @satohub/kit reference pins the package major.minor", () => {
  for (const f of FILES) {
    const s = read(f);
    assert.doesNotMatch(s, /latest/i, `${f} mentions latest`);
    for (const m of s.matchAll(/@satohub\/kit@([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)/g)) assert.equal(m[1], MM, `${f}: ${m[0]}`);
  }
});

test("server.json: registry name, npm package, stdio, versions match package.json", () => {
  const s = json("server.json");
  assert.match(s.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
  assert.equal(s.name, "ai.satohub/kit");
  assert.equal(s.version, PKG.version);
  assert.equal(s.packages.length, 1);
  const p = s.packages[0];
  assert.equal(p.registryType, "npm");
  assert.equal(p.identifier, PKG.name);
  assert.equal(p.version, PKG.version);
  assert.equal(p.transport.type, "stdio");
  assert.deepEqual(p.packageArguments, [{ type: "positional", value: "mcp" }]);
  assert.ok(s.description.length <= 100, "registry description limit");
});

test("every launcher runs `npx -y @satohub/kit@<mm> mcp`", () => {
  const expected = { command: "npx", args: ["-y", SPEC, "mcp"] };
  assert.deepEqual(json(".mcp.json").mcpServers["sato-kit"], expected);
  assert.deepEqual(json("gemini-extension.json").mcpServers["sato-kit"], expected);
  const llms = read("llms-install.md");
  const link = llms.match(/cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=sato-kit&config=([A-Za-z0-9+/=]+)/);
  assert.ok(link, "cursor deeplink");
  assert.deepEqual(JSON.parse(Buffer.from(link![1]!, "base64").toString("utf8")), expected);
});

test("plugin manifests agree on name and version and point at the skill", () => {
  for (const f of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "gemini-extension.json"]) {
    const m = json(f);
    assert.equal(m.name, "sato-kit", f);
    assert.equal(m.version, PKG.version, f);
  }
  assert.deepEqual(json(".claude-plugin/plugin.json").skills, ["./skill/"]);
  assert.equal(json(".claude-plugin/plugin.json").mcpServers, "./.mcp.json");
  assert.equal(json(".codex-plugin/plugin.json").skills, "./skill/");
});

test("SKILL.md: agentskills frontmatter, exact requires, prepare-before-execute, fork default", () => {
  const s = read("skill/SKILL.md");
  const fm = s.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, "frontmatter");
  assert.match(fm![1]!, /^name: sato-kit$/m);
  const desc = fm![1]!.match(/^description: (.+)$/m);
  assert.ok(desc && desc[1]!.length <= 1024);
  assert.match(fm![1]!, /bins: \["node", "npx"\]/);
  assert.match(fm![1]!, /env: \[\]/);
  for (const c of ["read", "prepare", "execute"]) assert.match(s, new RegExp(`npx -y ${SPEC.replace(/[.@/]/g, "\\$&")} ${c} .*--json`));
  assert.match(s, /execute --intent si_\.\.\. --json/);
  assert.match(s, /fork/);
  assert.ok(s.indexOf("Always `prepare` first") < s.indexOf("Run `execute` only after"));
});

test("copy never says safe, secure, best, guaranteed or fee-free", () => {
  for (const f of FILES) assert.doesNotMatch(read(f), /\b(safe|secure|best|guaranteed|fee-free)\b/i, f);
});

test("package.json carries mcpName for the MCP Registry", { skip: PKG.mcpName ? false : "mcpName is added to package.json at merge (owned by the skeleton lead)" }, () => {
  assert.equal(PKG.mcpName, json("server.json").name);
});
