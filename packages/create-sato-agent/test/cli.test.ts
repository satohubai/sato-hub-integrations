import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main, parseArgs, detectAgent, canPrompt, USER_AGENT, type Io } from "../src/index.js";

const FIXTURE = readFileSync(new URL("../../test/fixtures/templates.tar.gz", import.meta.url));

interface Seen { method: string; url: string; ua: string; body: any }
let server: Server;
let base = "";
const seen: Seen[] = [];

const OK_RESPONSE = {
  schema: "sato.create.response/v1",
  ok: true,
  template: { id: "base-guarded-trader", version: "0.1.0", digest: "sha256:abc", framework: "plain-ts" },
  files: [
    { path: ".env.example", encoding: "utf8", content: "SATO_RPC_URL_BASE=\n" },
    { path: "bin/run.sh", encoding: "base64", content: Buffer.from("#!/bin/sh\necho hi\n").toString("base64") },
    { path: "package.json", encoding: "utf8", content: '{"name":"x"}' },
  ],
  env_names: ["SATO_RPC_URL_BASE"],
  next_commands: ["npm ci", "cp .env.example .env", "npm test"],
  manifest: { schema: "sato.create/v1" },
  last_green: "2026-09-25",
  status_url: "https://satohub.ai/status",
  cli: 'npx create-sato-agent@0.1 "<goal>" --framework plain-ts',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
}

before(async () => {
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method!, url: req.url!, ua: String(req.headers["user-agent"]), body });
    if (req.url === "/tarball") { res.writeHead(200, { "content-type": "application/gzip" }); res.end(FIXTURE); return; }
    if (req.url === "/api/create") {
      if (body?.framework === "eliza") {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ schema: "sato.create.response/v1", ok: false, error: "no_template", message: "no eliza template yet", rule: "create.no_template", nearest: [{ id: "base-guarded-trader", framework: "plain-ts", intents: ["swap"], last_green: "2026-09-25" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(OK_RESPONSE));
      return;
    }
    res.writeHead(500); res.end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** A stdin that fails the test if anything reads from it. */
function throwingStdin(tty = true): Io["stdin"] {
  const s = new Readable({ read() { throw new Error("stdin was read"); } }) as Readable & { isTTY?: boolean };
  s.isTTY = tty;
  for (const m of ["on", "once", "addListener", "read", "resume", "pipe"] as const) {
    (s as any)[m] = () => { throw new Error(`stdin.${m} called`); };
  }
  return s;
}

function mkIo(argv: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  let stderr = "";
  const cwd = mkdtempSync(join(tmpdir(), "csa-"));
  const calls: string[] = [];
  const io: Io = {
    argv,
    env: {},
    cwd,
    stdin: throwingStdin(false),
    stdout: { write: (s: string) => { stdout += s; }, isTTY: false },
    stderr: { write: (s: string) => { stderr += s; } },
    run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return 0; },
    tarballUrl: `${base}/tarball`,
    ...extra,
  };
  return { io, cwd, calls, out: () => stdout, err: () => stderr, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("parseArgs: goal, flags, flagsPassed", () => {
  assert.equal(parseArgs(["swap usdc"]).flagsPassed, false);
  const o = parseArgs(["swap", "usdc", "--network", "testnet", "--no-git", "--dir=x"]);
  assert.equal(o.goal, "swap usdc");
  assert.equal(o.network, "testnet");
  assert.equal(o.git, false);
  assert.equal(o.dir, "x");
  assert.equal(o.flagsPassed, true);
});

test("agent detection covers CODEX_* prefix and named vars", () => {
  assert.equal(detectAgent({ CODEX_THREAD: "1" }), "CODEX_THREAD");
  assert.equal(detectAgent({ CLAUDECODE: "1" }), "CLAUDECODE");
  assert.equal(detectAgent({ HOME: "/x" }), null);
});

test("canPrompt: only a TTY person with no flags, no CI, no agent", () => {
  const tty = { stdin: { isTTY: true } as Io["stdin"], stdout: { write() {}, isTTY: true }, stderr: { write() {} }, argv: [], cwd: "/" };
  const none = parseArgs(["goal"]);
  assert.equal(canPrompt(none, { ...tty, env: {} }), true);
  assert.equal(canPrompt(none, { ...tty, env: { CI: "true" } }), false);
  assert.equal(canPrompt(none, { ...tty, env: { CURSOR_AGENT: "1" } }), false);
  assert.equal(canPrompt(parseArgs(["goal", "--yes"]), { ...tty, env: {} }), false);
});

test("agent mode never reads stdin, even on a TTY; writes files and prints next commands", async () => {
  const t = mkIo(["swap usdc to eth on base", "--json"], { env: { CLAUDECODE: "1" }, stdin: throwingStdin(true) });
  (t.io.stdout as any).isTTY = true;
  (t.io as any).argv = ["swap usdc to eth on base", "--api", `${base}/api/create`, "--json"];
  const code = await main(t.io);
  assert.equal(code, 0, t.out() + t.err());
  const r = JSON.parse(t.out());
  assert.deepEqual(Object.keys(r).sort(), ["dir", "env_names", "files_written", "last_green", "next_commands", "ok", "template"]);
  assert.equal(r.ok, true);
  assert.equal(r.last_green, "2026-09-25");
  assert.deepEqual(r.files_written, [".env.example", "bin/run.sh", "package.json"]);
  assert.ok(r.dir.endsWith("base-guarded-trader"));
  assert.equal(readFileSync(join(r.dir, "bin/run.sh"), "utf8"), "#!/bin/sh\necho hi\n");
  assert.equal(r.next_commands[0], "cd base-guarded-trader");
  assert.ok(!r.next_commands.includes("npm ci"), "npm ci already ran");
  assert.deepEqual(t.calls.slice(0, 2), ["npm install", "git init -q"]);
  const req = seen.filter((s) => s.url === "/api/create").at(-1)!;
  assert.equal(req.ua, USER_AGENT);
  assert.equal(req.body.network, "fork");
  assert.equal(req.body.goal, "swap usdc to eth on base");
  t.cleanup();
});

test("--yes without --i-accept-mainnet-risk refuses mainnet (exit 2, rule id, no request)", async () => {
  const before = seen.length;
  const t = mkIo(["goal", "--network", "mainnet", "--yes", "--json", "--api", `${base}/api/create`]);
  assert.equal(await main(t.io), 2);
  const r = JSON.parse(t.out());
  assert.equal(r.ok, false);
  assert.equal(r.error, "network_mainnet_not_accepted");
  assert.equal(r.rule, "cli.mainnet_confirm");
  assert.equal(seen.length, before);
  t.cleanup();
});

test("--network mainnet --i-accept-mainnet-risk sends mainnet_risk_accepted", async () => {
  const t = mkIo(["goal", "--network", "mainnet", "--i-accept-mainnet-risk", "--dry-run", "--json", "--api", `${base}/api/create`]);
  assert.equal(await main(t.io), 0, t.out());
  const req = seen.filter((s) => s.url === "/api/create").at(-1)!;
  assert.equal(req.body.network, "mainnet");
  assert.equal(req.body.mainnet_risk_accepted, true);
  t.cleanup();
});

test("server refusal → exit 2 with the rule and nearest", async () => {
  const t = mkIo(["goal", "--framework", "eliza", "--json", "--api", `${base}/api/create`]);
  assert.equal(await main(t.io), 2);
  const r = JSON.parse(t.out());
  assert.equal(r.error, "no_template");
  assert.equal(r.rule, "create.no_template");
  assert.equal(r.nearest[0].id, "base-guarded-trader");
  t.cleanup();
});

test("--dry-run --json writes nothing and lists files", async () => {
  const t = mkIo(["goal", "--dry-run", "--json", "--no-install", "--api", `${base}/api/create`]);
  assert.equal(await main(t.io), 0);
  const r = JSON.parse(t.out());
  assert.equal(r.dry_run, true);
  assert.deepEqual(r.files, [".env.example", "bin/run.sh", "package.json"]);
  assert.deepEqual(r.files_written, []);
  assert.equal(existsSync(r.dir), false);
  assert.deepEqual(t.calls, []);
  t.cleanup();
});

test("non-empty --dir is refused before any request", async () => {
  const t = mkIo([]);
  mkdirSync(join(t.cwd, "taken"));
  writeFileSync(join(t.cwd, "taken", "x"), "1");
  const before = seen.length;
  t.io.argv = ["goal", "--dir", "taken", "--json", "--api", `${base}/api/create`];
  assert.equal(await main(t.io), 2);
  assert.equal(JSON.parse(t.out()).rule, "cli.dir_not_empty");
  assert.equal(seen.length, before);
  t.cleanup();
});

test("non-empty default dir is refused after the plan", async () => {
  const t = mkIo([]);
  mkdirSync(join(t.cwd, "base-guarded-trader"));
  writeFileSync(join(t.cwd, "base-guarded-trader", "x"), "1");
  t.io.argv = ["goal", "--json", "--api", `${base}/api/create`];
  assert.equal(await main(t.io), 2);
  assert.equal(JSON.parse(t.out()).error, "dir_not_empty");
  t.cleanup();
});

test("--offline copies templates/<id>/<fw>/ from the tarball, skipping node_modules", async () => {
  const t = mkIo(["goal", "--offline", "--no-install", "--no-git", "--json"]);
  assert.equal(await main(t.io), 0, t.out());
  const r = JSON.parse(t.out());
  assert.deepEqual(r.files_written, [".env.example", "package-lock.json", "package.json", "src/index.js"]);
  assert.deepEqual(r.env_names, ["SATO_RPC_URL_BASE", "AGENT_PRIVATE_KEY"]);
  assert.equal(r.last_green, null);
  assert.deepEqual(r.next_commands, ["cd base-guarded-trader", "npm ci", "cp .env.example .env", "npm test", "npm start"]);
  assert.equal(readFileSync(join(r.dir, "src/index.js"), "utf8"), 'console.log("hi")\n');
  assert.equal(seen.at(-1)!.url, "/tarball");
  assert.equal(seen.at(-1)!.ua, USER_AGENT);
  t.cleanup();
});

test("--offline prints that it skipped the plan (human mode)", async () => {
  const t = mkIo(["goal", "--offline", "--no-install", "--no-git"]);
  assert.equal(await main(t.io), 0);
  assert.match(t.err(), /without a server plan or signed manifest/);
  t.cleanup();
});

test("--offline with an unknown template refuses", async () => {
  const t = mkIo(["goal", "--offline", "--template", "nope", "--json"]);
  assert.equal(await main(t.io), 2);
  assert.equal(JSON.parse(t.out()).error, "no_template");
  t.cleanup();
});

test("missing goal in agent mode refuses without reading stdin", async () => {
  const t = mkIo(["--json"]);
  assert.equal(await main(t.io), 2);
  assert.equal(JSON.parse(t.out()).rule, "create.goal_required");
  t.cleanup();
});

test("unreachable API is an error (exit 1)", async () => {
  const t = mkIo(["goal", "--json", "--api", "http://127.0.0.1:1/api/create"]);
  assert.equal(await main(t.io), 1);
  assert.equal(JSON.parse(t.out()).error, "network_error");
  t.cleanup();
});

test("path traversal in server files is refused", async () => {
  const t = mkIo(["goal", "--json", "--no-install", "--no-git", "--api", `${base}/api/create`], {
    fetch: (async () => new Response(JSON.stringify({ ...OK_RESPONSE, files: [{ path: "../evil", encoding: "utf8", content: "x" }] }), { status: 200 })) as typeof fetch,
  });
  assert.equal(await main(t.io), 1);
  assert.equal(JSON.parse(t.out()).error, "bad_path");
  t.cleanup();
});
