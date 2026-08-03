import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conceptsById, conceptsOfType, scanBundle } from "../src/bundle.js";

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-bundle-"));
  made.push(root);
  for (const [relPath, text] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
  }
  return root;
}

describe("scanBundle", () => {
  it("reports absence rather than failing when there is no bundle", async () => {
    const root = await repoWith({ "README.md": "# an ordinary repo\n" });
    const bundle = await scanBundle(root);
    expect(bundle.present).toBe(false);
    expect(bundle.concepts).toEqual([]);
  });

  it("reads concepts from the bundle root and its type directories", async () => {
    const root = await repoWith({
      "design/brief.md": "---\ntype: Brief\n---\nWhat we are building.\n",
      "design/todos.md": "---\ntype: Task Ledger\n---\n## Todo\n",
      "design/decisions/DDR-001-first.md":
        "---\ntype: Decision\nid: DDR-001\ndecision_status: accepted\n---\n",
      "design/feedback/FEEDBACK-001.md":
        "---\ntype: Feedback\nid: FEEDBACK-001\nfeedback_status: pending\n---\n",
      "design/glossary/design-record.md": "---\ntype: Term\n---\nThe record.\n",
    });

    const bundle = await scanBundle(root);

    expect(bundle.present).toBe(true);
    expect(bundle.concepts.map((c) => c.relPath)).toEqual([
      "brief.md",
      "decisions/DDR-001-first.md",
      "feedback/FEEDBACK-001.md",
      "glossary/design-record.md",
      "todos.md",
    ]);
    expect(bundle.concepts.flatMap((c) => c.problems)).toEqual([]);
  });

  it("never leaves the bundle, so a repo README is not a conformance problem", async () => {
    const root = await repoWith({
      "README.md": "# no frontmatter here\n",
      "CHANGELOG.md": "# nor here\n",
      "design/brief.md": "---\ntype: Brief\n---\n",
    });
    const bundle = await scanBundle(root);
    expect(bundle.concepts.map((c) => c.relPath)).toEqual(["brief.md"]);
  });

  it("collects OKF reserved files separately from concepts", async () => {
    const root = await repoWith({
      "design/index.md": '---\nokf_version: "0.2"\n---\n# Sections\n',
      "design/log.md": "# Update Log\n\n## 2026-07-27\n* **Creation**: seeded.\n",
      "design/decisions/index.md": "# Decisions\n",
      "design/brief.md": "---\ntype: Brief\n---\n",
    });

    const bundle = await scanBundle(root);

    expect(bundle.reserved.map((f) => f.relPath)).toEqual([
      "decisions/index.md",
      "index.md",
      "log.md",
    ]);
    expect(bundle.concepts.map((c) => c.relPath)).toEqual(["brief.md"]);
  });

  it("surfaces problems from the concepts it read without failing the scan", async () => {
    const root = await repoWith({
      "design/brief.md": "---\ntype: Brief\n---\n",
      "design/feedback/FEEDBACK-001.md": "no frontmatter at all\n",
    });

    const bundle = await scanBundle(root);

    expect(bundle.concepts).toHaveLength(2);
    const broken = bundle.concepts.find((c) => c.relPath === "feedback/FEEDBACK-001.md");
    expect(broken?.problems.map((p) => p.kind)).toContain("frontmatter-missing");
  });

  it("honors a configured record root", async () => {
    const root = await repoWith({ "knowledge/brief.md": "---\ntype: Brief\n---\n" });
    expect((await scanBundle(root, { recordRoot: "knowledge" })).present).toBe(true);
    expect((await scanBundle(root)).present).toBe(false);
  });

  it("ignores non-markdown files inside the bundle", async () => {
    const root = await repoWith({
      "design/brief.md": "---\ntype: Brief\n---\n",
      "design/notes.txt": "scratch\n",
    });
    expect((await scanBundle(root)).concepts).toHaveLength(1);
  });
});

describe("bundle indexes", () => {
  it("selects by type and indexes by id", async () => {
    const root = await repoWith({
      "design/questions/QUESTION-001.md":
        "---\ntype: Question\nid: QUESTION-001\nquestion_status: open\n---\n",
      "design/questions/QUESTION-002.md":
        "---\ntype: Question\nid: QUESTION-002\nquestion_status: resolved\n---\n",
      "design/brief.md": "---\ntype: Brief\n---\n",
    });

    const bundle = await scanBundle(root);

    expect(conceptsOfType(bundle, "Question").map((c) => c.id)).toEqual([
      "QUESTION-001",
      "QUESTION-002",
    ]);
    expect(conceptsById(bundle).get("QUESTION-002")?.domainStatus?.value).toBe("resolved");
    expect(conceptsById(bundle).has("brief")).toBe(false);
  });
});
