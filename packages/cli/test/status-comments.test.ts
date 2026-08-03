import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "../src/commands/init.js";
import { collectStatus, formatStatus } from "../src/commands/status.js";
import { projectUnfetchedCount } from "../src/comments-client.js";

let sandbox: string;
let server: http.Server;
let apiUrl: string;
let commentsBySnapshot: Record<string, number>;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-statcmt-"));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");

  commentsBySnapshot = {};
  server = http.createServer((req, res) => {
    const snapshot = new URL(req.url ?? "", "http://x").searchParams.get("snapshot") ?? "";
    const count = commentsBySnapshot[snapshot] ?? 0;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ comments: Array.from({ length: count }, (_, i) => ({ id: i })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  if (previousForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousForgeHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function configure(): Promise<void> {
  await fs.mkdir(process.env.FORGE_HOME!, { recursive: true });
  await fs.writeFile(
    path.join(process.env.FORGE_HOME!, "config.json"),
    JSON.stringify({ commentsApiUrl: apiUrl, commentsApiKey: "sk-test" }),
    "utf8",
  );
}

// Each repo gets its own directory: one shared "demo" path meant a second call
// silently overwrote the first one's freezes.json, which went unnoticed while
// every no-count case returned the same null (TASK-332).
async function makeFrozenRepo(snapshotIds: Array<string | null>, name = "demo"): Promise<string> {
  const root = path.join(sandbox, name);
  await initProject(root);
  await fs.mkdir(path.join(root, "todo"), { recursive: true });
  await fs.writeFile(
    path.join(root, "freezes.json"),
    JSON.stringify(
      snapshotIds.map((snapshotId, i) => ({
        tag: `v${i}`,
        date: "2026-07-02",
        commit: "abc",
        previewUrl: null,
        storybookUrl: null,
        pin: "123456",
        snapshotId,
      })),
    ),
    "utf8",
  );
  return root;
}

describe("projectUnfetchedCount", () => {
  it("sums unfetched comments across registered snapshots", async () => {
    await configure();
    const root = await makeFrozenRepo(["snap-a", null, "snap-b"]);
    commentsBySnapshot = { "snap-a": 2, "snap-b": 3 };
    expect(await projectUnfetchedCount(root)).toEqual({ kind: "count", count: 5 });
  });

  it("says which of the three reasons there is no count (TASK-332)", async () => {
    // One `null` for all three made `forge status` unable to answer the
    // question someone has right after configuring the key: did it work?
    const root = await makeFrozenRepo(["snap-a"]);
    expect(await projectUnfetchedCount(root)).toEqual({ kind: "not-configured" });

    await configure();
    expect(await projectUnfetchedCount(await makeFrozenRepo([null], "unfrozen"))).toEqual({
      kind: "no-snapshots",
    });

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    const down = await projectUnfetchedCount(root);
    server = http.createServer(() => {}); // placate afterEach close
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    expect(down).toEqual({ kind: "unreachable" });
  });
});

describe("forge status with the comment API configured", () => {
  it("shows the real unfetched count", async () => {
    await configure();
    await makeFrozenRepo(["snap-a"]);
    commentsBySnapshot = { "snap-a": 4 };

    const statuses = await collectStatus();
    expect(statuses[0]?.unfetchedComments).toEqual({ kind: "count", count: 4 });
    expect(formatStatus(statuses)).toContain("unfetched comments: 4");
  });
});
