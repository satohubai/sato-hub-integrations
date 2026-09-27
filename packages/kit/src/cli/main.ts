#!/usr/bin/env node
// bin: sato-kit (npx @satohub/kit). CLI builder owns this file.
import { runCli } from "./run.js";

runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
  isTTY: Boolean(process.stdout.isTTY),
}).then(
  (code) => { process.exitCode = code; },
  (e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; },
);
