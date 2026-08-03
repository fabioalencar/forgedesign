import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseTodos, taskView } from "@forgedesign/format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { parseTodo } from "../src/todo.js";
import { migrateTodos, upgradeRecord, upgradeRecordToV02 } from "../src/upgrade.js";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-upgrade-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

describe("migrateTodos (pure)", () => {
  it("maps sections, ids, and status; preserves other fields verbatim", () => {
    const oldDoc = parseTodo(
      `## Backlog\n- [ ] T-001 First\n  context: spec.md\n\n## In progress\n- [ ] T-002 Second\n\n## Done\n- [x] T-003 Third\n  notes: closes T-001 per DDR-050\n`,
    );
    const { doc, taskCount } = migrateTodos(oldDoc);
    expect(taskCount).toBe(3);
    expect(doc.sections.map((s) => s.heading)).toEqual(["Todo", "Doing", "Done", "Deferred"]);

    const migratedText = doc.sections
      .flatMap((s) => s.blocks)
      .flatMap((b) => (b.kind === "entry" ? b.entry.lines : []))
      .join("\n");

    expect(migratedText).toContain("- [ ] TASK-001 First");
    expect(migratedText).toContain("status: todo");
    expect(migratedText).toContain("- [ ] TASK-002 Second");
    expect(migratedText).toContain("status: doing");
    expect(migratedText).toContain("- [x] TASK-003 Third");
    expect(migratedText).toContain("status: done");
    // in-place T-### reference inside a notes field gets remapped too
    expect(migratedText).toContain("notes: closes TASK-001 per DDR-050");
    expect(migratedText).not.toMatch(/\bT-001\b/);
  });

  it("files a checked task as done wherever it sits, so a ticked box is never demoted", () => {
    // The common v1 drift: the box is ticked in place and the entry never moves
    // out of its Backlog section. Reading the section alone wrote `- [x] … /
    // status: todo` — a row contradicting itself, and 23 finished tasks
    // reported as open.
    const oldDoc = parseTodo(`## Backlog\n- [x] T-001 Finished but never moved\n`);
    const { doc } = migrateTodos(oldDoc);

    const done = doc.sections.find((s) => s.heading === "Done")!;
    const lines = done.blocks.flatMap((b) => (b.kind === "entry" ? b.entry.lines : []));
    expect(lines.join("\n")).toContain("- [x] TASK-001 Finished but never moved");
    expect(lines.join("\n")).toContain("status: done");
    expect(doc.sections.find((s) => s.heading === "Todo")!.blocks).toEqual([]);
  });

  it("moves the `### Phase` heading onto each row it covered (DDR-068)", () => {
    // The regroup by status is what forces this: one heading's tasks scatter
    // across all four sections, so the heading cannot stay where it was.
    const oldDoc = parseTodo(
      `## Backlog\n### Phase 47 — Renderer reconciliation\n- [ ] T-001 Open one\n- [x] T-002 Already done\n\n### Phase 49 — Format v0.2\n- [ ] T-003 Open two\n`,
    );
    const { doc, droppedBlocks } = migrateTodos(oldDoc);

    const rowFor = (id: string) =>
      doc.sections.flatMap((s) => s.blocks).find((b) => b.kind === "entry" && b.entry.id === id) as
        | { kind: "entry"; entry: { fields: Record<string, string> } }
        | undefined;

    expect(rowFor("TASK-001")?.entry.fields.phase).toBe("Phase 47 — Renderer reconciliation");
    // ...including the one the checkbox sent to a different section
    expect(rowFor("TASK-002")?.entry.fields.phase).toBe("Phase 47 — Renderer reconciliation");
    expect(rowFor("TASK-003")?.entry.fields.phase).toBe("Phase 49 — Format v0.2");
    expect(droppedBlocks).toBe(0);
  });

  it("counts prose it cannot carry rather than dropping it silently", () => {
    const oldDoc = parseTodo(
      `## Backlog\n### Phase 47 — Renderer reconciliation\n> Groomed 2026-07-27: work the sections in order.\n- [ ] T-001 Open one\n`,
    );
    expect(migrateTodos(oldDoc).droppedBlocks).toBe(1);
  });

  it("leaves an unchecked task where its section puts it", () => {
    const oldDoc = parseTodo(`## Done\n- [ ] T-001 Filed as done, box never ticked\n`);
    const { doc } = migrateTodos(oldDoc);
    const done = doc.sections.find((s) => s.heading === "Done")!;
    expect(done.blocks).toHaveLength(1);
  });
});

describe("upgradeRecord", () => {
  it("migrates todo.md, brief.md, glossary.md, and stamps forge.json", async () => {
    await write(
      "todo/todo.md",
      "## Backlog\n- [ ] T-001 Ship the thing\n  context: spec.md\n\n## Done\n- [x] T-002 Shipped\n",
    );
    await write("context/brief.md", "# Brief\n\nSee T-001 for the launch task.\n");
    await write("artifacts/glossary.md", "# Glossary\n\n- **Thing**: the thing from T-001.\n");
    await write("forge.json", '{\n  "preview": {\n    "dir": "prototype"\n  }\n}\n');

    const result = await upgradeRecord(root);

    expect(result.written.sort()).toEqual(["Brief.md", "Glossary.md", "Todos.md", "forge.json"]);
    expect(result.migratedTaskCount).toBe(2);

    const todosText = await fs.readFile(path.join(root, "Todos.md"), "utf8");
    expect(todosText).toContain("TASK-001 Ship the thing");
    expect(todosText).toContain("TASK-002 Shipped");

    const briefText = await fs.readFile(path.join(root, "Brief.md"), "utf8");
    expect(briefText).toContain("See TASK-001 for the launch task.");

    const glossaryText = await fs.readFile(path.join(root, "Glossary.md"), "utf8");
    expect(glossaryText).toContain("the thing from TASK-001.");

    const manifest = JSON.parse(await fs.readFile(path.join(root, "forge.json"), "utf8"));
    expect(manifest.formatVersion).toBe("0.1");
    expect(manifest.preview).toEqual({ dir: "prototype" }); // non-destructive merge

    // old v1 sources are never deleted
    expect(await fs.readFile(path.join(root, "todo", "todo.md"), "utf8")).toContain("T-001");

    // the migrated Todos.md round-trips through the format package's own parser
    const doc = parseTodos(todosText);
    const shipped = doc.sections
      .flatMap((s) => s.blocks)
      .find((b) => b.kind === "entry" && b.entry.id === "TASK-002");
    expect(shipped && shipped.kind === "entry" && taskView(shipped.entry).status).toBe("done");
  });

  it("rewrites T-### citations inside decisions, which do not move in this leg", async () => {
    await write("todo/todo.md", "## Backlog\n- [ ] T-001 Ship the thing\n- [ ] T-002 Second\n");
    await write(
      "decisions/DDR-001-a-choice.md",
      "# DDR-001 — A choice\n\n- **Status**: accepted\n\n## Decision\n\nTaken for T-001; T-002 follows.\n",
    );
    await write(
      "decisions/DDR-002-unrelated.md",
      "# DDR-002 — Unrelated\n\n## Decision\n\nNone.\n",
    );

    const result = await upgradeRecord(root);

    expect(result.rewritten).toEqual([path.join("decisions", "DDR-001-a-choice.md")]);
    const ddr = await fs.readFile(path.join(root, "decisions", "DDR-001-a-choice.md"), "utf8");
    expect(ddr).toContain("Taken for TASK-001; TASK-002 follows.");
    expect(ddr).not.toMatch(/\bT-00\d\b/);

    // a second run has nothing left to change, so it reports nothing
    expect((await upgradeRecord(root)).rewritten).toEqual([]);
  });

  it("leaves a T-### the ledger never declared alone rather than inventing a TASK for it", async () => {
    // A citation of a task that was deleted from todo.md is dangling either
    // way; renaming it would only make it look like it resolves.
    await write("todo/todo.md", "## Backlog\n- [ ] T-001 Ship the thing\n");
    await write(
      "decisions/DDR-001-a-choice.md",
      "# DDR-001 — A choice\n\n## Decision\n\nT-001 and the long-gone T-999.\n",
    );

    await upgradeRecord(root);
    const ddr = await fs.readFile(path.join(root, "decisions", "DDR-001-a-choice.md"), "utf8");
    expect(ddr).toContain("TASK-001 and the long-gone T-999.");
  });

  it("names the v1 sources that are now a second home, without deleting them (T-259)", async () => {
    await write("todo/todo.md", "## Backlog\n- [ ] T-001 First\n");
    await write("context/brief.md", "# Brief\n");
    await write("artifacts/glossary.md", "# Glossary\n");

    const result = await upgradeRecord(root);

    expect(result.superseded.sort()).toEqual([
      path.join("artifacts", "glossary.md"),
      path.join("context", "brief.md"),
      path.join("todo", "todo.md"),
    ]);
    expect(result.pruned).toEqual([]);
    await expect(fs.access(path.join(root, "todo", "todo.md"))).resolves.toBeUndefined();
  });

  it("--prune removes them and tidies the folder they were alone in", async () => {
    await write("todo/todo.md", "## Backlog\n- [ ] T-001 First\n");
    await write("context/brief.md", "# Brief\n");

    const result = await upgradeRecord(root, { prune: true });

    expect(result.pruned.sort()).toEqual([
      path.join("context", "brief.md"),
      path.join("todo", "todo.md"),
    ]);
    await expect(fs.access(path.join(root, "todo", "todo.md"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "todo"))).rejects.toThrow();
    // what it migrated into is still there
    await expect(fs.access(path.join(root, "Todos.md"))).resolves.toBeUndefined();
  });

  it("prunes on a later run that writes nothing — the review-then-prune flow", async () => {
    await write("todo/todo.md", "## Backlog\n- [ ] T-001 First\n");
    const first = await upgradeRecord(root);
    expect(first.pruned).toEqual([]);

    const second = await upgradeRecord(root, { prune: true });

    expect(second.written).toEqual([]); // nothing left to migrate
    expect(second.pruned).toEqual([path.join("todo", "todo.md")]);
  });

  it("leaves a v1 folder alone when something else still lives in it", async () => {
    await write("artifacts/glossary.md", "# Glossary\n");
    await write("artifacts/feedback/alpha/shot.png", "not really a png");

    await upgradeRecord(root, { prune: true });

    await expect(fs.access(path.join(root, "artifacts", "glossary.md"))).rejects.toThrow();
    await expect(
      fs.access(path.join(root, "artifacts", "feedback", "alpha", "shot.png")),
    ).resolves.toBeUndefined();
  });

  it("is idempotent: a second run skips already-migrated files and doesn't touch them", async () => {
    await write("todo/todo.md", "## Backlog\n- [ ] T-001 First\n");
    await upgradeRecord(root);
    const firstPass = await fs.readFile(path.join(root, "Todos.md"), "utf8");

    // hand-edit the migrated file, then re-run upgrade — it must not be clobbered
    await write("Todos.md", `${firstPass}\n<!-- hand edit -->\n`);
    const result = await upgradeRecord(root);

    expect(result.skipped).toContain("Todos.md");
    const secondPass = await fs.readFile(path.join(root, "Todos.md"), "utf8");
    expect(secondPass).toContain("<!-- hand edit -->");
  });

  it("is a no-op when there are no v1 sources", async () => {
    const result = await upgradeRecord(root);
    expect(result.written).toEqual([]);
    expect(result.migratedTaskCount).toBe(0);
  });

  it("refuses to migrate onto a differently-cased file, and says which one", async () => {
    // The youtube-lms dogfood case (T-250): a hand-written TODOS.md next to a
    // record that wants Todos.md. Before this, `fs.access("Todos.md")` on APFS
    // resolved to TODOS.md, upgrade called the record already-migrated, and the
    // real tasks never made it in.
    await write("todo/todo.md", "## Backlog\n- [ ] T-001 First\n");
    await write("TODOS.md", "# TODOs\n\nhand-written, not the record\n");

    const result = await upgradeRecord(root);

    expect(result.blocked).toEqual([{ target: "Todos.md", variant: "TODOS.md" }]);
    expect(result.written).not.toContain("Todos.md");
    expect(result.skipped).not.toContain("Todos.md");
    expect(result.migratedTaskCount).toBe(0);
    // the file that was already there is left exactly as it was
    expect(await fs.readFile(path.join(root, "TODOS.md"), "utf8")).toContain("not the record");
  });

  it("doctor sends the colliding v0.1 record to upgrade, which is what refuses it", async () => {
    // The case-collision rule was a v0.1 doctor rule and went with them
    // (DDR-095). The protection did not: `upgradeRecord` still refuses to write
    // across the collision, which is the moment it would do damage. Doctor's job
    // on a record this old is now to name the command that has the check.
    await write("TODOS.md", "# TODOs\n\nhand-written, not the record\n");
    await write("forge.json", '{\n  "formatVersion": "0.1"\n}\n');

    const result = await runDoctor(root);
    expect(result.exitCode).toBe(1);
    expect(result.findings).toEqual([expect.objectContaining({ rule: "format-version" })]);
    expect(result.findings[0]?.message).toContain("forge upgrade --to 0.2");
  });

  it("produces a record forge doctor accepts once both hops have run", async () => {
    // v1 -> v0.1 alone is no longer a destination: doctor refuses what it
    // leaves. The chain has to reach 0.2 for the migration to mean anything,
    // which is why `forge upgrade` now targets 0.2 by default.
    await write("todo/todo.md", "## Backlog\n- [ ] T-001 First\n");

    await upgradeRecord(root);
    expect((await runDoctor(root)).exitCode).toBe(1);

    await upgradeRecordToV02(root);
    expect((await runDoctor(root)).exitCode).toBe(0);
  });
});

describe("this repo's own ledger", () => {
  // This repository is a Design Record in the format these packages implement,
  // so its own ledger is a fixture that cannot go stale. Whether the whole
  // record is *valid* is `forge doctor`'s question over a committed tree, not
  // this test's against whatever is on disk mid-task. What is worth pinning
  // here is narrower: the ledger stays machine-readable by the package every
  // consumer reads it with, and no row contradicts itself about being done.
  async function forgeRoot(): Promise<string> {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
    });
    return stdout.trim();
  }

  it("parses, and no row contradicts itself about being done", async () => {
    const text = await fs.readFile(path.join(await forgeRoot(), "design", "todos.md"), "utf8");
    const doc = parseTodos(text);

    const rows = doc.sections.flatMap((section) =>
      section.blocks.flatMap((block) =>
        block.kind === "entry" ? [{ section: section.heading, view: taskView(block.entry) }] : [],
      ),
    );
    expect(rows.length).toBeGreaterThan(0);

    for (const { section, view } of rows) {
      expect(view.status, `${view.id} has no valid status`).toBe(section.toLowerCase());
      // the contradiction the v1 migration used to emit: a ticked box filed as open
      expect(view.checked, `${view.id}'s checkbox disagrees with its status`).toBe(
        view.status === "done",
      );
    }
  });

  function doc(text: string) {
    return parseTodos(text)
      .sections.flatMap((section) => section.blocks)
      .flatMap((block) => (block.kind === "entry" ? [taskView(block.entry)] : []));
  }
});
