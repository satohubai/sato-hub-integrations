// INTENT builder. Where prepared intents wait for execute.
//
// consume() is exactly-once: the record is marked consumed BEFORE it is
// returned, and every later consume() returns null (the kit turns that into
// "already executed"). fileIntentStore makes the mark with an atomic rename,
// so two processes sharing a directory cannot both consume one intent.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isIntentId } from "../spec/index.js";
import type { IntentRecord, IntentStore } from "../types.js";
import { randomIntentSecret } from "./hmac.js";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function memoryIntentStore(): IntentStore {
  const records = new Map<string, IntentRecord>();
  const consumed = new Set<string>();
  return {
    async put(record) {
      records.set(record.intent.intent_id, clone(record));
    },
    async get(id) {
      const r = records.get(id);
      return r ? clone(r) : null;
    },
    async consume(id) {
      const r = records.get(id);
      if (!r || consumed.has(id)) return null;
      consumed.add(id);
      return clone(r);
    },
  };
}

function assertId(id: string): void {
  // The id becomes a file name: only the contract shape is ever accepted.
  if (!isIntentId(id)) throw new Error("not an intent id");
}

async function readJson(path: string): Promise<IntentRecord | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as IntentRecord;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * One JSON file per intent in `dir` (mode 0600, written to a temp file and
 * renamed into place). Consumed intents are renamed to `<id>.consumed.json`.
 * The directory holds unsigned payloads — keep it out of version control.
 */
export function fileIntentStore(dir: string): IntentStore {
  const live = (id: string) => join(dir, `${id}.json`);
  const done = (id: string) => join(dir, `${id}.consumed.json`);
  return {
    async put(record) {
      const id = record.intent.intent_id;
      assertId(id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.${id}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
      await rename(tmp, live(id));
    },
    async get(id) {
      assertId(id);
      return (await readJson(live(id))) ?? (await readJson(done(id)));
    },
    async consume(id) {
      assertId(id);
      try {
        await rename(live(id), done(id)); // atomic: only one caller wins
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
      return readJson(done(id));
    },
  };
}

/**
 * Loads the intent secret from `<dir>/intent.key` (mode 0600), creating it on
 * first use, so intents survive a restart. The file is a secret: gitignore it.
 * Without it, createKit uses a random per-process secret and every prepared
 * intent becomes unexecutable when the process restarts.
 */
export async function loadOrCreateIntentSecret(dir: string): Promise<Uint8Array> {
  const path = join(dir, "intent.key");
  try {
    const hex = (await readFile(path, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${path} is not a 32-byte hex secret`);
    return new Uint8Array(Buffer.from(hex, "hex"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const secret = randomIntentSecret();
  try {
    await writeFile(path, Buffer.from(secret).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateIntentSecret(dir);
    throw e;
  }
  await chmod(path, 0o600);
  return secret;
}
