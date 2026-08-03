import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTriage, stageTriage } from "../src/commands/comments.js";
import { initProject } from "../src/commands/init.js";

const SNAPSHOT_ID = "3b241101-e2bb-4255-8caf-4136c566a962";

let sandbox: string;
let server: http.Server;
let base: string;
let served: unknown[];
let markFetchedCalls: unknown[];
let previousForgeHome: string | undefined;

const comment = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  parent_id: null,
  author_label: "PM",
  body: "the header feels heavy",
  route: "/settings",
  selector: "header",
  screenshot_url: null,
  created_at: "2026-07-04T10:00:00Z",
  ...over,
});

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-triage-"));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");

  served = [];
  markFetchedCalls = [];
  server = http.createServer((req, res) => {
    const send = (o: unknown) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(o));
    };
    if (req.method === "GET" && req.url?.startsWith("/comments"))
      return void send({ comments: served });
    let raw = "";
    req.on("data", (c: string) => (raw += c));
    req.on("end", () => {
      if (req.url === "/comments/mark-fetched") {
        markFetchedCalls.push(JSON.parse(raw));
        return send({ marked: 0 });
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  await fs.mkdir(process.env.FORGE_HOME!, { recursive: true });
  await fs.writeFile(
    path.join(process.env.FORGE_HOME!, "config.json"),
    JSON.stringify({ commentsApiUrl: base, commentsApiKey: "sk-test" }),
    "utf8",
  );
});

afterEach(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  if (previousForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousForgeHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const repo = path.join(sandbox, "repo");
  await fs.mkdir(repo, { recursive: true });
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  // A current record, because triage writes into the bundle and refuses
  // anything older (DDR-095). This used to be a bare directory, which the
  // deleted v0.1 writer happily turned into root-level ledgers.
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
        pin: "1",
        snapshotId: SNAPSHOT_ID,
      },
    ]),
    "utf8",
  );
  return repo;
}

async function stageProposal(repo: string, tag: string, items: unknown[]): Promise<void> {
  const dir = path.join(repo, ".forge", "triage", tag);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "proposal.json"), JSON.stringify({ items }), "utf8");
}

/** The bundle is where triage writes (DDR-095) — one concept file per feedback. */
const readFeedback = (repo: string, id: string) =>
  fs.readFile(path.join(repo, "design", "feedback", `${id}.md`), "utf8");
const readTodos = (repo: string) => fs.readFile(path.join(repo, "design", "todos.md"), "utf8");

describe("comment triage (stage/apply, spec/format.md)", () => {
  it("stages comments for the agent session", async () => {
    const repo = await makeRepo();
    served = [comment({}), comment({ author_label: "CEO", body: "love it" })];

    const staged = await stageTriage({ tag: "alpha", cwd: repo });
    expect(staged).toMatchObject({ count: 2, staged: ".forge/triage/alpha/comments.json" });
    expect(markFetchedCalls).toHaveLength(0); // not consumed until apply
  });

  it("refuses to apply before a proposal has been staged", async () => {
    const repo = await makeRepo();
    served = [comment({})];
    await stageTriage({ tag: "alpha", cwd: repo });
    await expect(applyTriage({ tag: "alpha", cwd: repo })).rejects.toThrow("no triage proposal");
    expect(markFetchedCalls).toHaveLength(0);
  });

  it("is a no-op when there is nothing to triage", async () => {
    const repo = await makeRepo();
    const result = await stageTriage({ tag: "alpha", cwd: repo });
    expect(result).toEqual({ staged: null, count: 0 });
    await expect(fs.access(path.join(repo, ".forge/triage"))).rejects.toThrow();
  });

  it("writes an accepted comment into the bundle and a new task into the ledger", async () => {
    const repo = await makeRepo();
    const heavy = comment({ body: "the header feels heavy" });
    served = [heavy];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [
      { commentId: heavy.id, disposition: "accepted", taskTitle: "Reduce header weight" },
    ]);

    const result = await applyTriage({ tag: "alpha", cwd: repo });
    expect(result.feedbackIds).toEqual(["FEEDBACK-001"]);
    expect(result.taskIds).toEqual(["TASK-001"]);
    expect(result.skipped).toEqual([]);
    expect(markFetchedCalls).toHaveLength(1);

    const feedbacks = await readFeedback(repo, "FEEDBACK-001");
    expect(feedbacks).toContain("id: FEEDBACK-001");
    expect(feedbacks).toContain("date: 2026-");
    expect(feedbacks).toContain("source: review");
    expect(feedbacks).toContain("freeze: FREEZE-001");
    expect(feedbacks).toContain("from: PM");
    expect(feedbacks).toContain("> the header feels heavy");
    expect(feedbacks).toContain("feedback_status: accepted");
    expect(feedbacks).toContain("resolution: TASK-001");

    const todos = await readTodos(repo);
    expect(todos).toContain("- [ ] TASK-001 Reduce header weight");
    expect(todos).toContain("genesis: FEEDBACK-001");
  });

  it("links an accepted comment to an existing task instead of creating one", async () => {
    const repo = await makeRepo();
    const ledger = path.join(repo, "design", "todos.md");
    await fs.writeFile(
      ledger,
      `${await fs.readFile(ledger, "utf8")}\n- [ ] TASK-009 Existing work\n  status: doing · opened: 2026-07-01\n`,
      "utf8",
    );
    const dup = comment({ body: "same issue, again" });
    served = [dup];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [
      { commentId: dup.id, disposition: "accepted", taskId: "TASK-009" },
    ]);

    const result = await applyTriage({ tag: "alpha", cwd: repo });
    expect(result.taskIds).toEqual(["TASK-009"]);

    const todos = await readTodos(repo);
    expect(todos).toContain("TASK-009 Existing work"); // untouched, not duplicated
    expect((todos.match(/TASK-009/g) ?? []).length).toBe(1);
  });

  it("rejects an accepted disposition that references a task that doesn't exist", async () => {
    const repo = await makeRepo();
    const c = comment({});
    served = [c];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [
      { commentId: c.id, disposition: "accepted", taskId: "TASK-999" },
    ]);
    await expect(applyTriage({ tag: "alpha", cwd: repo })).rejects.toThrow(/TASK-999/);
  });

  it("links a declined comment to an existing DDR, and rejects one that doesn't exist", async () => {
    const repo = await makeRepo();
    await fs.mkdir(path.join(repo, "design", "decisions"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "design", "decisions", "DDR-051-no-hide-pricing.md"),
      "---\ntype: Decision\nid: DDR-051\ntitle: X\ndate: 2026-07-01\ndecision_status: accepted\ncontext_source: test\n---\n## Decision\n\nX\n",
    );

    const c = comment({ body: "hide pricing for logged-out users" });
    served = [c];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [
      { commentId: c.id, disposition: "declined", ddrId: "DDR-051" },
    ]);

    const result = await applyTriage({ tag: "alpha", cwd: repo });
    expect(result.feedbackIds).toEqual(["FEEDBACK-001"]);
    expect(result.taskIds).toEqual([]);
    const feedbacks = await readFeedback(repo, "FEEDBACK-001");
    expect(feedbacks).toContain("feedback_status: declined");
    expect(feedbacks).toContain("resolution: DDR-051");
  });

  it("rejects a declined disposition with no matching DDR file", async () => {
    const repo = await makeRepo();
    const c = comment({});
    served = [c];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [
      { commentId: c.id, disposition: "declined", ddrId: "DDR-404" },
    ]);
    await expect(applyTriage({ tag: "alpha", cwd: repo })).rejects.toThrow(/DDR-404/);
  });

  it("writes deferred/pending comments with no link", async () => {
    const repo = await makeRepo();
    const a = comment({ body: "maybe later" });
    const b = comment({ body: "still thinking" });
    served = [a, b];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [
      { commentId: a.id, disposition: "deferred" },
      { commentId: b.id, disposition: "pending" },
    ]);

    await applyTriage({ tag: "alpha", cwd: repo });
    expect(await readFeedback(repo, "FEEDBACK-001")).toContain("feedback_status: deferred");
    expect(await readFeedback(repo, "FEEDBACK-002")).toContain("feedback_status: pending");
  });

  it("dates feedback when it arrived, not when triage got around to it (T-258)", async () => {
    const repo = await makeRepo();
    const lastWeek = comment({ created_at: "2026-07-04T10:00:00Z" });
    served = [lastWeek];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [{ commentId: lastWeek.id, disposition: "pending" }]);

    await applyTriage({ tag: "alpha", cwd: repo });

    const feedbacks = await readFeedback(repo, "FEEDBACK-001");
    expect(feedbacks).toContain("date: 2026-07-04");
  });

  it("opens the resulting task today, even when the comment is old", async () => {
    const repo = await makeRepo();
    const old = comment({ created_at: "2026-07-04T10:00:00Z" });
    served = [old];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [
      { commentId: old.id, disposition: "accepted", taskTitle: "Reduce header weight" },
    ]);

    await applyTriage({ tag: "alpha", cwd: repo });

    const todos = await readTodos(repo);
    const today = new Date().toISOString().slice(0, 10);
    expect(todos).toContain(`opened: ${today}`);
  });

  it("falls back to today rather than writing a date the format would reject", async () => {
    const repo = await makeRepo();
    const bad = comment({ created_at: "last tuesday" });
    const missing = comment({ created_at: undefined });
    served = [bad, missing];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [
      { commentId: bad.id, disposition: "pending" },
      { commentId: missing.id, disposition: "pending" },
    ]);

    await applyTriage({ tag: "alpha", cwd: repo });

    const today = new Date().toISOString().slice(0, 10);
    expect(await readFeedback(repo, "FEEDBACK-001")).toContain(`date: ${today}`);
    expect(await readFeedback(repo, "FEEDBACK-002")).toContain(`date: ${today}`);
  });

  it("records what the reviewer was doing, so the record can answer them later", async () => {
    const repo = path.join(sandbox, "v02");
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
          pin: "1",
          snapshotId: SNAPSHOT_ID,
        },
      ]),
      "utf8",
    );

    const guided = comment({
      body: "the approve button is easy to miss",
      scenario_id: "SCENARIO-002",
      step_id: "s2",
    });
    served = [guided];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [
      { commentId: guided.id, disposition: "accepted", taskTitle: "Make approve primary" },
    ]);

    await applyTriage({ tag: "alpha", cwd: repo });

    const written = await fs.readFile(
      path.join(repo, "design", "feedback", "FEEDBACK-001.md"),
      "utf8",
    );
    // the comment id is what the resolution trail syncs on (T-294)…
    expect(written).toContain(`comment: ${guided.id}`);
    // …and the scenario/step are what triage reads as context (T-297).
    expect(written).toContain("scenario: SCENARIO-002");
    expect(written).toContain("step: s2");
  });

  it("carries route and selector into the concept — where it was written (TASK-324)", async () => {
    const repo = path.join(sandbox, "v02-where");
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
          pin: "1",
          snapshotId: SNAPSHOT_ID,
        },
      ]),
      "utf8",
    );

    const placed = comment({
      body: "the enterprise column reads like an afterthought",
      route: "/pricing",
      selector: "#tiers > div:nth-child(3)",
    });
    served = [placed];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [
      { commentId: placed.id, disposition: "accepted", taskTitle: "Rebuild the pricing table" },
    ]);

    await applyTriage({ tag: "alpha", cwd: repo });

    const written = await fs.readFile(
      path.join(repo, "design", "feedback", "FEEDBACK-001.md"),
      "utf8",
    );
    // The staged comment carried both all along; triage used to drop them, so
    // the reading pane could not answer "where was this".
    expect(written).toContain("route: /pricing");
    expect(written).toContain("selector:");
    expect(written).toContain("#tiers > div:nth-child(3)");
  });

  it("skips a comment the proposal doesn't mention, but still marks the rest fetched", async () => {
    const repo = await makeRepo();
    const dispositioned = comment({ body: "handled" });
    const forgotten = comment({ body: "not mentioned in the proposal" });
    served = [dispositioned, forgotten];
    await stageTriage({ tag: "alpha", cwd: repo });
    await stageProposal(repo, "alpha", [{ commentId: dispositioned.id, disposition: "pending" }]);

    const result = await applyTriage({ tag: "alpha", cwd: repo });
    expect(result.skipped).toEqual([forgotten.id]);
    expect(result.feedbackIds).toHaveLength(1);
    expect(markFetchedCalls).toHaveLength(1); // still an at-least-once batch mark
  });
});
