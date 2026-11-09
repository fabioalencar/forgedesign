import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConcept } from "@forgedesign/format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { initProject } from "../src/init.js";
import { addRecordQuestion } from "../src/questions.js";
import { openTaskLedger } from "../src/task-ledger.js";

let sandbox: string;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-question-"));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");
});

afterEach(async () => {
  if (previousForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousForgeHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function write(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

describe("forge question (T-282) — v0.2", () => {
  it("writes a concept doctor accepts, and allocates the next id", async () => {
    const root = path.join(sandbox, "demo");
    await initProject(root);

    const first = await addRecordQuestion(root, {
      question: "Can tier names change without legal review?",
      context: "brief.md",
      date: "2026-07-19",
    });

    expect(first).toEqual({
      id: "QUESTION-001",
      path: path.join("design", "questions", "QUESTION-001.md"),
    });

    const concept = parseConcept(
      "questions/QUESTION-001.md",
      await fs.readFile(path.join(root, first.path), "utf8"),
    );
    expect(concept.problems).toEqual([]);
    expect(concept.frontmatter).toMatchObject({
      type: "Question",
      id: "QUESTION-001",
      title: "Can tier names change without legal review?",
      date: "2026-07-19",
      question_status: "open",
      context: "brief.md",
    });

    // the id comes from what is already on disk, which is the whole point of a
    // writer over a hand-written file
    const second = await addRecordQuestion(root, { question: "And the second?" });
    expect(second.id).toBe("QUESTION-002");

    expect((await runDoctor(root)).findings).toEqual([]);
  });

  it("refuses a resolved question with nothing to point at", async () => {
    const root = path.join(sandbox, "demo");
    await initProject(root);

    await expect(
      addRecordQuestion(root, { question: "Answered how?", status: "resolved" }),
    ).rejects.toThrow(/--link/);
  });

  it("records a question that arrives already answered", async () => {
    const root = path.join(sandbox, "demo");
    await initProject(root);

    const result = await addRecordQuestion(root, {
      question: "Do we hide pricing?",
      status: "resolved",
      link: "DDR-051",
    });
    const text = await fs.readFile(path.join(root, result.path), "utf8");
    expect(text).toContain("question_status: resolved");
    expect(text).toContain("resolution: DDR-051");
  });

  it("refuses a question with no text", async () => {
    const root = path.join(sandbox, "demo");
    await initProject(root);
    await expect(addRecordQuestion(root, { question: "   " })).rejects.toThrow("needs text");
  });
});

describe("forge task add (T-282)", () => {
  it("allocates the next id from whichever ledger the repo has", async () => {
    const root = path.join(sandbox, "demo");
    await initProject(root);

    const ledger = await openTaskLedger(root);
    const id = ledger?.add({ title: "Reduce header weight", genesis: "QUESTION-001" });
    await ledger?.save();

    expect(ledger?.layout).toBe("v0.2");
    expect(id).toBe("TASK-001");
    const todos = await fs.readFile(path.join(root, "design", "todos.md"), "utf8");
    expect(todos).toContain("TASK-001 Reduce header weight");
    expect(todos).toContain("genesis: QUESTION-001");
  });
});

describe("a new concept never replaces a file at its path (TASK-537)", () => {
  it("refuses, and keeps the other writer's file, when its id was taken mid-run", async () => {
    const root = path.join(sandbox, "demo");
    await initProject(root);
    // Another writer's QUESTION-001, landed between this command's scan and its
    // write — so the scan did not see it. A file the scan cannot read stands in.
    const theirs = "a stakeholder's question, mid-write by the dashboard\n";
    await write(root, "design/questions/QUESTION-001.md", theirs);

    await expect(addRecordQuestion(root, { question: "Mine?" })).rejects.toThrow(
      /QUESTION-001\.md already exists — something else wrote it while this ran/,
    );
    expect(await fs.readFile(path.join(root, "design/questions/QUESTION-001.md"), "utf8")).toBe(
      theirs,
    );
  });
});
