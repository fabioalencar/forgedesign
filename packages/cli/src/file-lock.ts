// One writer at a time for a shared state file (TASK-548, DDR-160).
//
// The task ledger and `freezes.json` are read, changed and written back by
// the CLI, the dashboard's background jobs and whatever agent is running
// `forge` beside them. Writing atomically (TASK-535) means nobody reads half a
// file, and re-reading before the write (TASK-536) narrows the window in which
// two writers both read the old file — but narrowing is not closing: twenty
// writers started together lost 164 of 200 tasks between them. A lock around
// the read, the change and the write closes it.
//
// The lock is a file created with `wx` under `.forge/locks/`, which
// `forge init` gitignores: beside `todos.md` it would show in `git status`, and
// one left behind by a crash would hold up `forge freeze`'s clean-tree check.
// It records who holds it, so a holder that died, or one that has held it far
// longer than any write takes, is taken over rather than waited on forever.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export interface LockOptions {
  /** how long to wait for a live holder before giving up (ms) */
  timeoutMs?: number;
  /** a lock older than this is abandoned, whoever holds it (ms) */
  staleMs?: number;
}

interface Holder {
  pid: number | null;
  host: string | null;
  token: string | null;
  /** when the lock file was last written — the age a holder is judged by */
  mtimeMs: number;
}

const RETRY_MS = 10;

/** Where the lock for `name` in this repository lives. */
export function lockPath(repoRoot: string, name: string): string {
  return path.join(repoRoot, ".forge", "locks", `${name}.lock`);
}

/**
 * Runs `fn` holding the repository's `name` lock: no other process running
 * `withRepoLock` with the same name runs at the same time. The lock is released
 * when `fn` settles, whatever it does.
 */
export async function withRepoLock<T>(
  repoRoot: string,
  name: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const file = lockPath(repoRoot, name);
  const token = await acquire(file, name, options);
  try {
    return await fn();
  } finally {
    await release(file, token);
  }
}

async function acquire(file: string, name: string, options: LockOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const body = `${JSON.stringify({ pid: process.pid, host: hostname(), token, at: new Date().toISOString() })}\n`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.writeFile(file, body, { flag: "wx" });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await readHolder(file);
    if (holder === null) continue; // released between our attempt and the read
    if (isAbandoned(holder, staleMs)) {
      await takeOver(file, holder);
      continue;
    }
    if (Date.now() >= deadline) {
      const who = holder.pid === null ? "another process" : `process ${holder.pid}`;
      throw new Error(
        `${name} is being written by ${who} (${path.relative(process.cwd(), file) || file}) — try again; if nothing is running, delete that file`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS + Math.random() * RETRY_MS));
  }
}

async function readHolder(file: string): Promise<Holder | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  let text: string;
  try {
    [stat, text] = await Promise.all([fs.stat(file), fs.readFile(file, "utf8")]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // Created and written in two steps, so it can be read empty; then only its
  // age speaks for it.
  let parsed: { pid?: unknown; host?: unknown; token?: unknown } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    // just created
  }
  return {
    pid: typeof parsed.pid === "number" ? parsed.pid : null,
    host: typeof parsed.host === "string" ? parsed.host : null,
    token: typeof parsed.token === "string" ? parsed.token : null,
    mtimeMs: stat.mtimeMs,
  };
}

/** Held too long, or held by a process on this machine that no longer exists. */
function isAbandoned(holder: Holder, staleMs: number): boolean {
  if (Date.now() - holder.mtimeMs > staleMs) return true;
  if (holder.pid === null || holder.host !== hostname()) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    // EPERM: alive, someone else's. Only ESRCH says it is gone.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Removes an abandoned lock — only the one judged abandoned, not one taken since. */
async function takeOver(file: string, abandoned: Holder): Promise<void> {
  const now = await readHolder(file);
  if (now === null || now.token !== abandoned.token || now.mtimeMs !== abandoned.mtimeMs) return;
  await fs.rm(file, { force: true });
}

/** Removes the lock if it is still ours: one judged abandoned may have been taken over. */
async function release(file: string, token: string): Promise<void> {
  const holder = await readHolder(file).catch(() => null);
  if (holder?.token === token) await fs.rm(file, { force: true });
}
