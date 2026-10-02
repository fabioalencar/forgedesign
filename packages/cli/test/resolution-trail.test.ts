import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "../src/commands/init.js";
import { resolveTrail } from "../src/resolution-trail.js";

const SNAPSHOT_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const COMMENT_HEAVY = "11111111-1111-4111-8111-111111111111";
const COMMENT_LATER = "22222222-2222-4222-8222-222222222222";
const COMMENT_PRICING = "33333333-3333-4333-8333-333333333333";

interface ResolvePayload {
  snapshotId: string;
  resolutions: Array<{
    commentId: string;
    status: string;
    resolvedInTag?: string | null;
    resolvedInUrl?: string | null;
    note?: string | null;
  }>;
}

let sandbox: string;
let server: http.Server;
let base: string;
let resolveCalls: ResolvePayload[];
let resolveStatus: number;
let resolveAuth: Array<string | undefined>;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-trail-"));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");

  resolveCalls = [];
  resolveAuth = [];
  resolveStatus = 200;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      // The direct comment API and the control plane's `/api/cli` proxy of it
      // take the same body at the same path, under different prefixes.
      if (req.url === "/comments/resolve" || req.url === "/api/cli/comments/resolve") {
        resolveAuth.push(req.headers.authorization);
        res.statusCode = resolveStatus;
        res.setHeader("Content-Type", "application/json");
        if (resolveStatus !== 200) return void res.end(JSON.stringify({ error: "db is down" }));
        const payload = JSON.parse(raw) as ResolvePayload;
        resolveCalls.push(payload);
        return void res.end(JSON.stringify({ resolved: payload.resolutions.length }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  await fs.mkdir(process.env.FORGE_HOME as string, { recursive: true });
  await fs.writeFile(
    path.join(process.env.FORGE_HOME as string, "config.json"),
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

const feedback = (fields: Record<string, string>, quote: string) =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n\n> ${quote}\n`;

/**
 * A record mid-loop: one accepted comment whose task shipped, one accepted
 * comment still open, one declined, and one that never came from a review.
 */
async function makeRecord(): Promise<string> {
  const root = path.join(sandbox, "demo");
  await initProject(root);
  const design = path.join(root, "design");

  await fs.writeFile(
    path.join(root, "freezes.json"),
    JSON.stringify([
      {
        tag: "alpha",
        date: "2026-07-04",
        commit: "a",
        previewUrl: "https://demo-alpha.test",
        storybookUrl: null,
        pin: "111111",
        snapshotId: SNAPSHOT_ID,
      },
      {
        tag: "v3",
        date: "2026-07-28",
        commit: "b",
        previewUrl: "https://demo-v3.test",
        storybookUrl: null,
        pin: "222222",
        snapshotId: null,
      },
    ]),
    "utf8",
  );

  await fs.writeFile(
    path.join(design, "todos.md"),
    "---\ntype: Task Ledger\ntitle: Todos\n---\n\n" +
      "## Todo\n- [ ] TASK-002 Add an empty state\n  status: todo · opened: 2026-07-05\n\n" +
      "## Done\n- [x] TASK-001 Reduce header weight\n  status: done · opened: 2026-07-05\n",
    "utf8",
  );

  await fs.mkdir(path.join(design, "decisions"), { recursive: true });
  await fs.writeFile(
    path.join(design, "decisions", "DDR-051-pricing-stays-visible.md"),
    feedback(
      {
        type: "Decision",
        id: "DDR-051",
        title: "Pricing stays visible to logged-out visitors",
        decision_status: "accepted",
      },
      "Pricing stays visible.",
    ),
    "utf8",
  );

  await fs.mkdir(path.join(design, "feedback"), { recursive: true });
  await fs.writeFile(
    path.join(design, "feedback", "FEEDBACK-001.md"),
    feedback(
      {
        type: "Feedback",
        id: "FEEDBACK-001",
        title: "The header feels heavy",
        date: "2026-07-04",
        feedback_status: "accepted",
        source: "review",
        freeze: "FREEZE-001",
        from: "PM",
        resolution: "TASK-001",
        comment: COMMENT_HEAVY,
      },
      "the header feels heavy",
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(design, "feedback", "FEEDBACK-002.md"),
    feedback(
      {
        type: "Feedback",
        id: "FEEDBACK-002",
        title: "The empty list says nothing",
        date: "2026-07-04",
        feedback_status: "accepted",
        source: "review",
        freeze: "FREEZE-001",
        from: "PM",
        resolution: "TASK-002",
        comment: COMMENT_LATER,
      },
      "the empty list says nothing",
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(design, "feedback", "FEEDBACK-003.md"),
    feedback(
      {
        type: "Feedback",
        id: "FEEDBACK-003",
        title: "Hide pricing from logged-out visitors",
        date: "2026-07-04",
        feedback_status: "declined",
        source: "review",
        freeze: "FREEZE-001",
        from: "CEO",
        resolution: "DDR-051",
        comment: COMMENT_PRICING,
      },
      "hide pricing from logged-out visitors",
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(design, "feedback", "FEEDBACK-004.md"),
    feedback(
      {
        type: "Feedback",
        id: "FEEDBACK-004",
        title: "Said in the hallway",
        date: "2026-07-04",
        feedback_status: "accepted",
        source: "meeting",
        from: "PM",
        resolution: "TASK-001",
      },
      "said in the hallway",
    ),
    "utf8",
  );
  return root;
}

const readFeedback = (root: string, id: string) =>
  fs.readFile(path.join(root, "design", "feedback", `${id}.md`), "utf8");

describe("the resolution trail (T-294)", () => {
  it("closes the loop for a Cloud creator signed in with forge login (TASK-477)", async () => {
    // Every other `forge comments` subcommand went Cloud-first in TASK-420;
    // this one kept reading only the operator's direct key, so a customer's
    // "addressed in v3" never reached the stakeholder.
    await fs.writeFile(
      path.join(process.env.FORGE_HOME as string, "config.json"),
      JSON.stringify({ cloudToken: "tok-creator", cloudApiUrl: base }),
      "utf8",
    );
    const root = await makeRecord();

    const result = await resolveTrail({ tag: "v3", cwd: root });

    expect(result.addressed).toBe(1);
    expect(resolveCalls).toHaveLength(1);
    expect(resolveAuth).toEqual(["Bearer tok-creator"]);
  });

  it("names forge login when nothing is signed in", async () => {
    await fs.writeFile(path.join(process.env.FORGE_HOME as string, "config.json"), "{}", "utf8");
    const root = await makeRecord();
    await expect(resolveTrail({ tag: "v3", cwd: root })).rejects.toThrow(/forge login/);
  });

  it("addresses shipped feedback, declines with the decision, and leaves open work alone", async () => {
    const root = await makeRecord();

    const result = await resolveTrail({ tag: "v3", cwd: root });

    expect(result.addressed).toBe(1);
    expect(result.declined).toBe(1);
    expect(result.stamped).toEqual(["FEEDBACK-001"]);
    expect(result.warnings).toEqual([]);

    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]?.snapshotId).toBe(SNAPSHOT_ID);
    expect(resolveCalls[0]?.resolutions).toEqual([
      {
        commentId: COMMENT_HEAVY,
        status: "addressed",
        resolvedInTag: "v3",
        resolvedInUrl: "https://demo-v3.test",
      },
      {
        commentId: COMMENT_PRICING,
        status: "declined",
        note: "DDR-051: Pricing stays visible to logged-out visitors",
      },
    ]);

    // the shipped one is stamped with the release that shipped it…
    const shipped = await readFeedback(root, "FEEDBACK-001");
    expect(shipped).toContain("feedback_status: done");
    expect(shipped).toContain("addressed_in: v3");
    // …and the one whose task is still open says nothing yet.
    expect(await readFeedback(root, "FEEDBACK-002")).not.toContain("addressed_in");
  });

  it("tells the service what answered a stakeholder's question, by id and title, and stamps nothing (TASK-462)", async () => {
    const root = await makeRecord();
    const questions = path.join(root, "design", "questions");
    await fs.mkdir(questions, { recursive: true });
    const question = (id: string, fields: Record<string, string>) =>
      fs.writeFile(
        path.join(questions, `${id}.md`),
        feedback(
          {
            type: "Question",
            id,
            title: "Why is there only one way in?",
            date: "2026-07-04",
            source: "review",
            freeze: "FREEZE-001",
            from: "PM",
            ...fields,
          },
          "Why is there only one way in?",
        ),
        "utf8",
      );
    const ANSWERED = "44444444-4444-4444-8444-444444444444";
    const DROPPED = "55555555-5555-4555-8555-555555555555";
    const OPEN = "66666666-6666-4666-8666-666666666666";
    await question("QUESTION-001", {
      question_status: "resolved",
      resolution: "DDR-051",
      comment: ANSWERED,
    });
    await question("QUESTION-002", {
      question_status: "dropped",
      resolution: "DDR-051",
      comment: DROPPED,
    });
    await question("QUESTION-003", { question_status: "open", comment: OPEN });

    const result = await resolveTrail({ tag: "v3", cwd: root });

    expect(result.answered).toBe(1);
    expect(result.declined).toBe(2); // the dropped question and the declined feedback
    expect(result.stamped).toEqual(["FEEDBACK-001"]); // questions carry no stamp
    const resolutions = resolveCalls[0]?.resolutions ?? [];
    expect(resolutions).toContainEqual({
      commentId: ANSWERED,
      status: "addressed",
      note: "DDR-051: Pricing stays visible to logged-out visitors",
    });
    expect(resolutions).toContainEqual({
      commentId: DROPPED,
      status: "declined",
      note: "DDR-051: Pricing stays visible to logged-out visitors",
    });
    // An open question has nothing to say yet.
    expect(resolutions.some((r) => r.commentId === OPEN)).toBe(false);
  });

  it("re-pushes settled feedback on the next release without re-stamping it", async () => {
    const root = await makeRecord();
    await resolveTrail({ tag: "v3", cwd: root });
    resolveCalls = [];

    const second = await resolveTrail({ tag: "v4", cwd: root });

    expect(second.stamped).toEqual([]);
    expect(second.addressed).toBe(0);
    // the already-addressed comment still reports v3, not the release running now
    expect(resolveCalls[0]?.resolutions).toContainEqual({
      commentId: COMMENT_HEAVY,
      status: "addressed",
      resolvedInTag: "v3",
      resolvedInUrl: "https://demo-v3.test",
    });
  });

  it("does not stamp the record when the service refuses the push", async () => {
    const root = await makeRecord();
    resolveStatus = 500;

    const result = await resolveTrail({ tag: "v3", cwd: root });

    expect(result.stamped).toEqual([]);
    expect(result.warnings.join(" ")).toContain("resolution sync failed");
    expect(await readFeedback(root, "FEEDBACK-001")).not.toContain("addressed_in");
  });

  it("warns instead of guessing when the freeze has no registered snapshot", async () => {
    const root = await makeRecord();
    const freezes = JSON.parse(await fs.readFile(path.join(root, "freezes.json"), "utf8"));
    freezes[0].snapshotId = null;
    await fs.writeFile(path.join(root, "freezes.json"), JSON.stringify(freezes), "utf8");

    const result = await resolveTrail({ tag: "v3", cwd: root });

    expect(resolveCalls).toEqual([]);
    expect(result.warnings.join(" ")).toContain("FREEZE-001 has no registered snapshot");
  });
});
