#!/usr/bin/env node
// Writes the action reference table into README.md between the markers, from
// the registered descriptors in the BUILT package (run `npm run build` first).
// `--check` exits 1 when README.md differs from what would be written.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderActionsDoc, spliceReadme } from "./actions-doc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { coreActions, toolDefinitions } = await import(join(ROOT, "dist/index.js"));
const actions = coreActions();
const block = renderActionsDoc({
  actions,
  defaultDefs: toolDefinitions({ actions, toolsets: "default" }),
  allDefs: toolDefinitions({ actions, toolsets: "all" }),
});
const path = join(ROOT, "README.md");
const before = readFileSync(path, "utf8");
const after = spliceReadme(before, block);
if (process.argv.includes("--check")) {
  if (before !== after) {
    console.error("README.md is out of date; run node scripts/gen-actions-doc.mjs");
    process.exit(1);
  }
  console.log("README.md action reference is current");
} else {
  writeFileSync(path, after);
  console.log(before === after ? "README.md unchanged" : "README.md updated");
}
