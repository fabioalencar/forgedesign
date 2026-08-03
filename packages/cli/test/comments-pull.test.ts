import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveTag, pullComments } from "../src/commands/comments.js";
import type { ApiComment } from "../src/comments-client.js";
import { findSection, findTask, getField, parseTodo, tasksInSection } from "../src/todo.js";
import { makeDesignRepo } from "./helpers.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SNAPSHOT_ID = "3b241101-e2bb-4255-8caf-4136c566a962";

let sandbox: string;
let server: http.Server;
let apiUrl: string;
let served: ApiComment[];
let markFetchedCalls: Array<{ snapshotId: string; commentIds: string[] }>;
let archiveCalls: number;
let previousForgeHome: string | undefined;

function comment(over: Partial<ApiComment>): ApiComment {
  return {
    id: crypto.randomUUID(),
    parent_id: null,
    author_label: "PM",
    body: "Something to fix",
    route: "/settings",
    selector: "header > nav",
    viewport_w: 1280,
    viewport_h: 800,
    screenshot_url: null,
    created_at: "2026-07-02T10:00:00Z",
    ...over,
  };
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-pull-"));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");

  served = [];
  markFetchedCalls = [];
  archiveCalls = 0;
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/comments")) {
      res.setHeader("Content-Type", "application/json");
      return void res.end(JSON.stringify({ comments: served }));
    }
    if (req.method === "GET" && req.url === "/shot.png") {
      res.setHeader("Content-Type", "image/png");
      return void res.end(PNG);
    }
    if (req.method === "POST" && req.url === `/snapshots/${SNAPSHOT_ID}/archive`) {
      archiveCalls += 1;
      res.setHeader("Content-Type", "application/json");
      return void res.end(JSON.stringify({ archived: true, alreadyArchived: archiveCalls > 1 }));
    }
    if (req.method === "POST" && req.url === "/comments/mark-fetched") {
      let raw = "";
      req.on("data", (c: string) => (raw += c));
      return void req.on("end", () => {
        markFetchedCalls.push(JSON.parse(raw));
        res.setHeader("Content-Type", "application/json");
        res.end('{"marked":0}');
      });
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  await fs.mkdir(process.env.FORGE_HOME!, { recursive: true });
  await fs.writeFile(
    path.join(process.env.FORGE_HOME!, "config.json"),
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

/**
 * A pre-0.2 repo, which is the only shape `pull` has ever worked in.
 *
 * This fixture used to be `makeDesignRepo` — a *current* record — with a
 * `todo/todo.md` written on top of it "because pull still promotes into the v1
 * ledger, which init no longer scaffolds". That is the file the command needs
 * and no real record has, so the fixture manufactured the condition that hid
 * the bug: `pull` crashed on every genuine v0.2 record while these tests were
 * green (TASK-384). The manufacturing is gone; what is left is an honest v1
 * repo, and a separate test for what a current record now gets.
 */
async function makeFrozenRepo(): Promise<string> {
  const root = await makeLegacyRepo();
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

/** A genuine pre-0.2 repo: no manifest, a v1 ledger, and git. */
async function makeLegacyRepo(): Promise<string> {
  const root = path.join(sandbox, "legacy");
  await fs.mkdir(path.join(root, "todo"), { recursive: true });
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await fs.writeFile(path.join(root, "todo/todo.md"), "## Backlog\n\n## Done\n", "utf8");
  return root;
}

describe("pullComments", () => {
  it("converts threads into Inbox todo items with all spec fields", async () => {
    const root = await makeFrozenRepo();
    const rootComment = comment({
      body: "The header feels heavy\non mobile.",
      screenshot_url: `${apiUrl}/shot.png`,
    });
    const reply = comment({
      parent_id: rootComment.id,
      author_label: "Designer",
      body: "Agreed, try 48px.",
      route: null,
      selector: null,
    });
    const second = comment({ author_label: "CEO", body: "Love it.", selector: null });
    served = [rootComment, reply, second];

    const result = await pullComments({ tag: "alpha", cwd: root });
    expect(result).toEqual({ created: 2, fetched: 3, screenshots: 1 });

    const doc = parseTodo(await fs.readFile(path.join(root, "todo/todo.md"), "utf8"));
    const inbox = findSection(doc, "Inbox — alpha")!;
    const tasks = tasksInSection(inbox);
    expect(tasks).toHaveLength(2);

    const first = findTask(doc, "T-001")!.task;
    expect(first.title).toBe("The header feels heavy / on mobile.");
    expect(getField(first, "quote")).toBe('"The header feels heavy / on mobile."');
    expect(getField(first, "route")).toBe("/settings");
    expect(getField(first, "selector")).toBe("header > nav");
    expect(getField(first, "tag")).toBe("alpha");
    expect(getField(first, "author")).toBe("PM");
    expect(getField(first, "timestamp")).toBe("2026-07-02T10:00:00Z");
    expect(getField(first, "reply")).toBe('"Agreed, try 48px." — Designer');
    expect(getField(first, "screenshot")).toBe(
      path.join("artifacts", "feedback", "alpha", `${rootComment.id}.png`),
    );

    const screenshot = await fs.readFile(
      path.join(root, "artifacts/feedback/alpha", `${rootComment.id}.png`),
    );
    expect(screenshot.subarray(0, 4)).toEqual(PNG.subarray(0, 4));

    expect(markFetchedCalls).toEqual([
      { snapshotId: SNAPSHOT_ID, commentIds: [rootComment.id, reply.id, second.id] },
    ]);
  });

  it("assigns fresh permanent ids on top of existing tasks", async () => {
    const root = await makeFrozenRepo();
    const todoPath = path.join(root, "todo/todo.md");
    await fs.writeFile(
      todoPath,
      "# demo backlog\n\n## Backlog\n\n- [ ] T-041 Existing work\n\n## Done\n",
      "utf8",
    );
    served = [comment({})];

    await pullComments({ tag: "alpha", cwd: root });
    const doc = parseTodo(await fs.readFile(todoPath, "utf8"));
    expect(tasksInSection(findSection(doc, "Inbox — alpha")!)[0]?.id).toBe("T-042");
  });

  it("is a no-op when there is nothing unfetched", async () => {
    const root = await makeFrozenRepo();
    const before = await fs.readFile(path.join(root, "todo/todo.md"), "utf8");

    const result = await pullComments({ tag: "alpha", cwd: root });
    expect(result).toEqual({ created: 0, fetched: 0, screenshots: 0 });
    expect(await fs.readFile(path.join(root, "todo/todo.md"), "utf8")).toBe(before);
    expect(markFetchedCalls).toHaveLength(0);
  });

  it("archiveTag archives the tag's snapshot and reports repeats", async () => {
    const root = await makeFrozenRepo();
    expect(await archiveTag({ tag: "alpha", cwd: root })).toEqual({ alreadyArchived: false });
    expect(await archiveTag({ tag: "alpha", cwd: root })).toEqual({ alreadyArchived: true });
    expect(archiveCalls).toBe(2);
    await expect(archiveTag({ tag: "nope", cwd: root })).rejects.toThrow(/no freeze named/);
  });

  it("fails clearly for unknown tags and unregistered freezes", async () => {
    const root = await makeFrozenRepo();
    await expect(pullComments({ tag: "beta", cwd: root })).rejects.toThrow(/no freeze named/);

    const freezes = JSON.parse(await fs.readFile(path.join(root, "freezes.json"), "utf8"));
    freezes[0].snapshotId = null;
    await fs.writeFile(path.join(root, "freezes.json"), JSON.stringify(freezes), "utf8");
    await expect(pullComments({ tag: "alpha", cwd: root })).rejects.toThrow(
      /no registered snapshot/,
    );
  });
  it("refuses on a current record, before the comments are consumed (TASK-384)", async () => {
    // The failure the creator hit live on `v4`: a raw ENOENT for `todo/todo.md`
    // in a project that has never been in that layout. It now says what to run
    // instead — and it says it *before* fetching, so `triage` still finds the
    // comments. A refusal that burned the queue would be worse than the crash.
    const root = await makeDesignRepo(sandbox, "current");
    await fs.writeFile(
      path.join(root, "freezes.json"),
      JSON.stringify([
        {
          tag: "alpha",
          date: "2026-07-04",
          commit: "a",
          previewUrl: null,
          storybookUrl: null,
          pin: "1",
          snapshotId: SNAPSHOT_ID,
        },
      ]),
      "utf8",
    );

    await expect(pullComments({ tag: "alpha", cwd: root })).rejects.toThrow(
      /forge comments triage alpha/,
    );
    expect(markFetchedCalls).toHaveLength(0);
  });
});
