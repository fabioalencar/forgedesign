import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveTag } from "../src/commands/comments.js";

// `archiveTag` is version-agnostic — it archives a freeze's snapshot through the
// comment API and never touches the ledger — so this needs only a git repo with
// a freezes.json registering the tag, and a mock service. (Split out of the old
// comments-pull suite when `pull` was deleted, TASK-384.)

const SNAPSHOT_ID = "3b241101-e2bb-4255-8caf-4136c566a962";

let sandbox: string;
let server: http.Server;
let apiUrl: string;
let archiveCalls: number;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-archive-"));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");

  archiveCalls = 0;
  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === `/snapshots/${SNAPSHOT_ID}/archive`) {
      archiveCalls += 1;
      res.setHeader("Content-Type", "application/json");
      return void res.end(JSON.stringify({ archived: true, alreadyArchived: archiveCalls > 1 }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  await fs.mkdir(process.env.FORGE_HOME as string, { recursive: true });
  await fs.writeFile(
    path.join(process.env.FORGE_HOME as string, "config.json"),
    JSON.stringify({ commentsApiUrl: apiUrl, commentsApiKey: "sk-test" }),
    "utf8",
  );
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  if (previousForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousForgeHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function makeFrozenRepo(): Promise<string> {
  const root = path.join(sandbox, "repo");
  await fs.mkdir(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  await fs.writeFile(
    path.join(root, "freezes.json"),
    JSON.stringify([
      {
        tag: "alpha",
        date: "2026-07-02",
        commit: "abc",
        previewUrl: "https://x.vercel.app",
        storybookUrl: null,
        pin: "123456",
        snapshotId: SNAPSHOT_ID,
      },
    ]),
    "utf8",
  );
  return root;
}

describe("archiveTag", () => {
  it("archives the tag's snapshot and reports a repeat", async () => {
    const root = await makeFrozenRepo();
    expect(await archiveTag({ tag: "alpha", cwd: root })).toEqual({ alreadyArchived: false });
    expect(await archiveTag({ tag: "alpha", cwd: root })).toEqual({ alreadyArchived: true });
  });

  it("fails clearly for a tag with no freeze", async () => {
    const root = await makeFrozenRepo();
    await expect(archiveTag({ tag: "nope", cwd: root })).rejects.toThrow(/no freeze named/);
  });
});
