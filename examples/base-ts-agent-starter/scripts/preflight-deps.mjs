#!/usr/bin/env node
// Preflight this project's own dependencies BEFORE `npm install` runs.
//
// Zero dependencies on purpose: it has to work before anything is installed.
// Sends this package.json to Sato Hub's Preflight batch endpoint, which looks
// each package name up in the directory Sato Hub already holds. It sends no
// request to the packages themselves, and it answers with what is on record.
//
//   node scripts/preflight-deps.mjs                 # blocks install on a "no" verdict
//   node scripts/preflight-deps.mjs --fail-on caution
//
// What a verdict is NOT: a security review, an audit, or a malware scan.
// `unknown` means Sato Hub holds no record of that package. It does not mean
// the package is bad, and it cannot fail the install at any --fail-on setting.
//
// This script does not verify the response signature, because the verifier
// (satohub-core) is one of the packages it is checking. The swap quote in
// src/agent.ts IS verified, by satohub-core, after install.

import { readFileSync } from "node:fs";

const BASE = (process.env.SATO_BASE_URL || "https://satohub.ai").replace(/\/+$/, "");
const UA = process.env.SATO_USER_AGENT || "base-ts-agent-starter/0.1";
const i = process.argv.indexOf("--fail-on");
const FAIL_ON = i >= 0 ? process.argv[i + 1] : "no";
if (!["no", "caution", "none"].includes(FAIL_ON)) {
  console.error("--fail-on must be one of: no, caution, none");
  process.exit(2);
}

const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");

let res;
try {
  res = await fetch(`${BASE}/api/preflight/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ manifest, manifest_kind: "package.json", manifest_path: "package.json", fail_on: FAIL_ON }),
    signal: AbortSignal.timeout(60_000),
  });
} catch (e) {
  console.error(`Preflight could not reach ${BASE} (${e?.name || "error"}). Nothing was checked; this is not a verdict.`);
  console.error("Install anyway only if you decide to: npm install");
  process.exit(1);
}
if (!res.ok) {
  console.error(`Preflight answered HTTP ${res.status}. Nothing was checked; this is not a verdict.`);
  process.exit(1);
}
const body = await res.json();

console.log(`Sato Hub Preflight — ${body.results.length} dependencies, fail_on=${body.fail_on}`);
for (const r of body.results) {
  const first = r.evidence?.[0];
  console.log(`  ${r.verdict.padEnd(8)} ${r.target.padEnd(14)} rule ${r.rule}${r.sato_url ? `  ${r.sato_url}` : ""}`);
  if (first) console.log(`           ${first.check}: ${first.result}`);
}
const s = body.summary;
console.log(`  go ${s.go} · caution ${s.caution} · no ${s.no} · unknown ${s.unknown}`);
if (s.unknown > 0) {
  console.log("  unknown = Sato Hub holds no record of that package. Not a verdict either way.");
}
if (body.exit_code !== 0) {
  console.error(`Preflight returned a blocking verdict under fail_on=${body.fail_on}; not installing.`);
  process.exit(body.exit_code);
}
console.log("Preflight done. Installing.");
