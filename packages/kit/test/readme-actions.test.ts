// The README's action reference is generated from the registry
// (scripts/gen-actions-doc.mjs). This fails when a descriptor changes and the
// README was not regenerated. Reads files only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { coreActions } from "../src/actions/index.js";
import { toolDefinitions } from "../src/surface/index.js";

// Compiled to .test-build/test/*.js -> package root is two levels up.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("README action reference matches the registered descriptors", async () => {
  const mod: any = await import(pathToFileURL(join(ROOT, "scripts/actions-doc.mjs")).href);
  const actions = coreActions();
  const block: string = mod.renderActionsDoc({
    actions,
    defaultDefs: toolDefinitions({ actions, toolsets: "default" }),
    allDefs: toolDefinitions({ actions, toolsets: "all" }),
  });
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.equal(mod.spliceReadme(readme, block), readme, "README.md drifted from the registry; run node scripts/gen-actions-doc.mjs");
  for (const a of actions) assert.ok(readme.includes(`\`${a.descriptor.id}\``), a.descriptor.id);
});
