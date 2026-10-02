import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTriage } from "../src/commands/comments.js";
import { initProject } from "../src/commands/init.js";
import {
  figmaComments,
  figmaFileKey,
  githubIssues,
  githubRepo,
  readImportedBatch,
  stageImport,
} from "../src/comments-import.js";

let sandbox: string;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-import-"));
  previousForgeHome = process.env.FORGE_HOME;
  // No comment API configured at all: an import must not need one.
  process.env.FORGE_HOME = path.join(sandbox, ".forge");
  await fs.mkdir(process.env.FORGE_HOME, { recursive: true });
});

afterEach(async () => {
  if (previousForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousForgeHome;
  delete process.env.FIGMA_TOKEN;
  delete process.env.FIGMA_API_URL;
  await fs.rm(sandbox, { recursive: true, force: true });
});

const FIGMA_EXPORT = {
  comments: [
    {
      id: "101",
      file_key: "abc123",
      parent_id: "",
      user: { id: "u1", handle: "Julia Reis", img_url: "" },
      created_at: "2026-08-20T10:00:00Z",
      resolved_at: null,
      message: "The password rules should show before I type.",
      client_meta: { node_id: "12:34", node_offset: { x: 10, y: 20 } },
      order_id: "1",
    },
    {
      id: "102",
      file_key: "abc123",
      parent_id: "101",
      user: { id: "u2", handle: "Ana Martins", img_url: "" },
      created_at: "2026-08-20T11:00:00Z",
      resolved_at: null,
      message: "Agreed.",
      client_meta: { x: 1, y: 2 },
      order_id: "2",
    },
    {
      id: "103",
      file_key: "abc123",
      parent_id: "",
      user: { id: "u1", handle: "Julia Reis", img_url: "" },
      created_at: "2026-08-21T09:00:00Z",
      resolved_at: "2026-08-22T09:00:00Z",
      message: "Old and settled.",
      client_meta: { x: 1, y: 2 },
      order_id: "3",
    },
  ],
};

async function makeRepo(name = "repo"): Promise<string> {
  const repo = path.join(sandbox, name);
  await fs.mkdir(repo, { recursive: true });
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await initProject(repo);
  await fs.writeFile(
    path.join(repo, "freezes.json"),
    JSON.stringify([
      {
        tag: "alpha",
        date: "2026-07-04",
        commit: "a",
        previewUrl: null,
        storybookUrl: null,
        snapshotId: null,
      },
    ]),
    "utf8",
  );
  return repo;
}

describe("figmaComments (TASK-463)", () => {
  it("maps the API's export onto the staged shape, links each comment, and leaves resolved ones out", () => {
    const { comments, resolved } = figmaComments(FIGMA_EXPORT);
    expect(resolved).toBe(1);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      id: "101",
      parent_id: null,
      author_label: "Julia Reis",
      body: "The password rules should show before I type.",
      route: null,
      selector: null,
      url: "https://www.figma.com/file/abc123?node-id=12%3A34&comment=101",
      created_at: "2026-08-20T10:00:00Z",
    });
    expect(comments[1]).toMatchObject({ id: "102", parent_id: "101", author_label: "Ana Martins" });
    expect(figmaComments(FIGMA_EXPORT, { includeResolved: true }).comments).toHaveLength(3);
  });

  it("refuses something that is not a Figma export, rather than staging nothing quietly", () => {
    expect(() => figmaComments({ data: [] })).toThrow(/not a Figma comments export/);
  });

  it("reads a file key out of a Figma URL", () => {
    expect(figmaFileKey("https://www.figma.com/design/abc123/Login-flow?node-id=1-2")).toBe(
      "abc123",
    );
    expect(figmaFileKey("https://www.figma.com/file/xyz/Name")).toBe("xyz");
    expect(figmaFileKey("plainkey")).toBe("plainkey");
  });
});

describe("githubIssues (TASK-463)", () => {
  it("maps the REST list, skipping pull requests and closed issues, and reads the gh CLI's shape too", () => {
    const rest = [
      {
        number: 7,
        title: "Sign-in error names the field",
        body: "It says which of the two was wrong.",
        state: "open",
        user: { login: "julia" },
        html_url: "https://github.com/acme/login/issues/7",
        created_at: "2026-08-20T10:00:00Z",
      },
      { number: 8, title: "A PR", state: "open", user: { login: "bot" }, pull_request: {} },
      { number: 9, title: "Closed", state: "closed", user: { login: "julia" } },
    ];
    const { comments, closed, pullRequests } = githubIssues(rest);
    expect({ closed, pullRequests }).toEqual({ closed: 1, pullRequests: 1 });
    expect(comments).toEqual([
      expect.objectContaining({
        id: "7",
        author_label: "julia",
        body: "Sign-in error names the field\n\nIt says which of the two was wrong.",
        url: "https://github.com/acme/login/issues/7",
        created_at: "2026-08-20T10:00:00Z",
      }),
    ]);

    const gh = [
      {
        number: 10,
        title: "From gh",
        body: "",
        state: "OPEN",
        author: { login: "ana" },
        url: "https://github.com/acme/login/issues/10",
        createdAt: "2026-08-21T10:00:00Z",
      },
    ];
    expect(githubIssues(gh).comments[0]).toMatchObject({
      id: "10",
      author_label: "ana",
      body: "From gh",
      url: "https://github.com/acme/login/issues/10",
      created_at: "2026-08-21T10:00:00Z",
    });
    expect(githubIssues(rest, { includeClosed: true }).comments).toHaveLength(2);
  });

  it("reads owner/repo out of a GitHub URL", () => {
    expect(githubRepo("https://github.com/acme/login/issues")).toBe("acme/login");
    expect(githubRepo("acme/login.git")).toBe("acme/login");
  });
});

describe("stageImport", () => {
  it("stages a saved export under .forge/triage/<batch>/ with a manifest, and stops there", async () => {
    const repo = await makeRepo();
    const file = path.join(sandbox, "figma.json");
    await fs.writeFile(file, JSON.stringify(FIGMA_EXPORT), "utf8");

    const result = await stageImport({ root: repo, source: "figma", input: file, freeze: "alpha" });
    const today = new Date().toISOString().slice(0, 10);
    expect(result).toMatchObject({
      batch: `figma-${today}`,
      count: 2,
      staged: path.join(".forge", "triage", `figma-${today}`, "comments.json"),
      skipped: { settled: 1, pullRequests: 0, alreadyInRecord: 0 },
    });
    const staged = JSON.parse(
      await fs.readFile(path.join(repo, result.staged as string), "utf8"),
    ) as unknown[];
    expect(staged).toHaveLength(2);
    expect(await readImportedBatch(repo, result.batch)).toMatchObject({
      source: "figma",
      origin: file,
      freeze: "alpha",
    });
    // Nothing in the record yet — the record is the creator's to write.
    await expect(fs.access(path.join(repo, "design", "feedback"))).rejects.toThrow();
  });

  it("refuses to overwrite a batch that is staged and not applied", async () => {
    const repo = await makeRepo();
    const file = path.join(sandbox, "figma.json");
    await fs.writeFile(file, JSON.stringify(FIGMA_EXPORT), "utf8");
    await stageImport({ root: repo, source: "figma", input: file, batch: "round-1" });
    await expect(
      stageImport({ root: repo, source: "figma", input: file, batch: "round-1" }),
    ).rejects.toThrow(/already holds a staged batch/);
  });

  it("does not stage a comment the record already holds — the record is what says seen", async () => {
    const repo = await makeRepo();
    const file = path.join(sandbox, "figma.json");
    await fs.writeFile(file, JSON.stringify(FIGMA_EXPORT), "utf8");
    await fs.mkdir(path.join(repo, "design", "feedback"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "design", "feedback", "FEEDBACK-001.md"),
      "---\ntype: Feedback\nid: FEEDBACK-001\ntitle: seen\ndate: 2026-08-20\nfeedback_status: pending\nsource: figma\nurl: https://www.figma.com/file/abc123?node-id=12%3A34&comment=101\n---\n> seen\n",
      "utf8",
    );

    const result = await stageImport({ root: repo, source: "figma", input: file, batch: "again" });
    expect(result.count).toBe(1);
    expect(result.skipped.alreadyInRecord).toBe(1);
  });

  it("fetches a file key with the creator's own token, from the creator's machine", async () => {
    const repo = await makeRepo();
    const seen: Array<{ url: string; token: string | undefined }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "", token: req.headers["x-figma-token"] as string | undefined });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(FIGMA_EXPORT));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.FIGMA_API_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.FIGMA_TOKEN = "figd_secret";
    try {
      const result = await stageImport({
        root: repo,
        source: "figma",
        input: "https://www.figma.com/design/abc123/Login",
        batch: "fetched",
      });
      expect(result.count).toBe(2);
      expect(seen).toEqual([{ url: "/v1/files/abc123/comments", token: "figd_secret" }]);
    } finally {
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    }
  });

  it("says how to get the export when there is no token to fetch with", async () => {
    const repo = await makeRepo();
    await expect(
      stageImport({ root: repo, source: "figma", input: "abc123", batch: "x" }),
    ).rejects.toThrow(/FIGMA_TOKEN/);
  });
});

describe("applying an imported batch", () => {
  it("writes feedback that says where it came from and links back, with no service in the loop", async () => {
    const repo = await makeRepo();
    const file = path.join(sandbox, "issues.json");
    await fs.writeFile(
      file,
      JSON.stringify([
        {
          number: 7,
          title: "Sign-in error names the field",
          body: "It says which of the two was wrong.",
          state: "open",
          user: { login: "julia" },
          html_url: "https://github.com/acme/login/issues/7",
          created_at: "2026-08-20T10:00:00Z",
        },
      ]),
      "utf8",
    );
    const staged = await stageImport({
      root: repo,
      source: "issue",
      input: file,
      batch: "gh",
      freeze: "alpha",
    });
    expect(staged.count).toBe(1);
    await fs.writeFile(
      path.join(repo, ".forge", "triage", "gh", "proposal.json"),
      JSON.stringify({
        items: [{ commentId: "7", disposition: "accepted", taskTitle: "Stop naming the field" }],
      }),
      "utf8",
    );

    const result = await applyTriage({ tag: "gh", cwd: repo });
    expect(result.feedbackIds).toEqual(["FEEDBACK-001"]);
    expect(result.taskIds).toEqual(["TASK-001"]);

    const written = await fs.readFile(
      path.join(repo, "design", "feedback", "FEEDBACK-001.md"),
      "utf8",
    );
    expect(written).toContain("source: issue");
    expect(written).toContain("freeze: FREEZE-001");
    expect(written).toContain("from: julia");
    expect(written).toContain("url: https://github.com/acme/login/issues/7");
    expect(written).toContain("date: 2026-08-20");
    expect(written).toContain("resolution: TASK-001");
    // No service comment id: there is nothing for the trail to sync on.
    expect(written).not.toContain("comment:");
  });

  it("refuses a batch that names a freeze the registry does not have", async () => {
    const repo = await makeRepo();
    const file = path.join(sandbox, "figma.json");
    await fs.writeFile(file, JSON.stringify(FIGMA_EXPORT), "utf8");
    await stageImport({ root: repo, source: "figma", input: file, batch: "b", freeze: "nope" });
    await fs.writeFile(
      path.join(repo, ".forge", "triage", "b", "proposal.json"),
      JSON.stringify({ items: [{ commentId: "101", disposition: "pending" }] }),
      "utf8",
    );
    await expect(applyTriage({ tag: "b", cwd: repo })).rejects.toThrow(/"nope"/);
  });
});
