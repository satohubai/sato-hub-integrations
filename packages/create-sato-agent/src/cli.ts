#!/usr/bin/env node
import { main } from "./index.js";

main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}).then((code) => { process.exitCode = code; });
