import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockPath, withRepoLock } from "../src/file-lock.js";
import { appendFreeze, type FreezeRecord, readFreezes } from "../src/freezes.js";

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "forge-lock-")));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function plantLock(name: string, holder: { pid: number; token?: string }, ageMs = 0) {
  const file = lockPath(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ pid: holder.pid, host: hostname(), token: holder.token ?? "planted" }),
  );
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    await fs.utimes(file, then, then);
  }
  return file;
}

/** A pid that existed and does not any more. */
function deadPid(): number {
  return Number(
    execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]),
  );
}

describe("withRepoLock (TASK-548)", () => {
  it("lets one holder in at a time, and leaves nothing behind", async () => {
    const events: string[] = [];
    const section = (who: string) =>
      withRepoLock(root, "todos", async () => {
        events.push(`${who} in`);
        await sleep(30);
        events.push(`${who} out`);
      });

    await Promise.all([section("a"), section("b"), section("c")]);

    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]?.replace(" in", "")).toBe(events[i + 1]?.replace(" out", ""));
    }
    await expect(fs.access(lockPath(root, "todos"))).rejects.toThrow();
  });

  it("releases the lock when the work throws", async () => {
    await expect(
      withRepoLock(root, "todos", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withRepoLock(root, "todos", async () => "next")).resolves.toBe("next");
  });

  it("takes over a lock whose holder has died", async () => {
    await plantLock("todos", { pid: deadPid() });
    await expect(withRepoLock(root, "todos", async () => "mine", { timeoutMs: 200 })).resolves.toBe(
      "mine",
    );
  });

  it("takes over a lock held far longer than any write takes, whoever holds it", async () => {
    await plantLock("todos", { pid: process.pid }, 60_000);
    await expect(
      withRepoLock(root, "todos", async () => "mine", { timeoutMs: 200, staleMs: 30_000 }),
    ).resolves.toBe("mine");
  });

  it("waits for a live holder, then refuses and says who holds it", async () => {
    await plantLock("todos", { pid: process.pid });
    await expect(
      withRepoLock(root, "todos", async () => "mine", { timeoutMs: 100 }),
    ).rejects.toThrow(`todos is being written by process ${process.pid}`);
    // The live holder's lock is still there.
    await expect(fs.access(lockPath(root, "todos"))).resolves.toBeUndefined();
  });

  it("is one lock however the repository's path is spelled", async () => {
    // The dashboard has the path `forge init` was given; the CLI has git's
    // resolved toplevel. Through a symlink both reach the same lock file.
    await plantLock("todos", { pid: process.pid });
    const link = path.join(path.dirname(root), `${path.basename(root)}-link`);
    await fs.symlink(root, link);
    try {
      await expect(
        withRepoLock(link, "todos", async () => "mine", { timeoutMs: 100 }),
      ).rejects.toThrow("todos is being written by process");
    } finally {
      await fs.rm(link);
    }
  });

  it("does not remove a lock that is no longer its own", async () => {
    await withRepoLock(root, "todos", async () => {
      // Judged abandoned and taken over by someone else while this ran.
      await fs.writeFile(lockPath(root, "todos"), JSON.stringify({ pid: 1, token: "theirs" }));
    });
    expect(await fs.readFile(lockPath(root, "todos"), "utf8")).toContain("theirs");
  });
});

describe("writers that share a file wait for each other (TASK-548)", () => {
  it("keeps every task when twelve processes add to one ledger at once", async () => {
    // Separate processes, because that is the case the lock exists for: the
    // CLI, the dashboard's jobs and an agent each run their own.
    await fs.mkdir(path.join(root, "design"));
    await fs.writeFile(
      path.join(root, "design", "todos.md"),
      "---\ntype: Task Ledger\ntitle: Todos\n---\n## Todo\n\n## Doing\n\n## Done\n\n## Deferred\n",
    );
    const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
    const writer = (n: number) => `
      const { saveLedgerAdditions } = await import(${JSON.stringify(`${dist}/task-ledger.js`)});
      await saveLedgerAdditions(${JSON.stringify(root)}, "design/todos.md", "", [
        { section: "Todo", input: { id: "TASK-${String(n).padStart(3, "0")}", title: "writer ${n}", status: "todo", opened: "2026-10-13" } },
      ]);`;

    const codes = await Promise.all(
      Array.from(
        { length: 12 },
        (_, i) =>
          new Promise<number | null>((resolve) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", writer(i + 1)], {
              stdio: "ignore",
            });
            child.on("close", resolve);
          }),
      ),
    );

    expect(codes.every((code) => code === 0)).toBe(true);
    const ledger = await fs.readFile(path.join(root, "design", "todos.md"), "utf8");
    expect(ledger.match(/TASK-\d{3}/g)?.sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `TASK-${String(i + 1).padStart(3, "0")}`),
    );
  }, 30_000);

  it("records a freeze once, though two of the same tag both passed the early check", async () => {
    const freeze = (tag: string): FreezeRecord => ({
      tag,
      date: "2026-10-13",
      commit: "c",
      previewUrl: null,
      storybookUrl: null,
      snapshotId: null,
    });

    const results = await Promise.allSettled([
      appendFreeze(root, freeze("v1")),
      appendFreeze(root, freeze("v1")),
      appendFreeze(root, freeze("v2")),
    ]);

    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await readFreezes(root)).map((f) => f.tag).sort()).toEqual(["v1", "v2"]);
  });
});
