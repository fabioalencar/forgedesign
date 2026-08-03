import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { allEntries, parseConcept, parseTodos } from "@forgedesign/format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTaskLedger, readTaskCounts } from "../src/task-ledger.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-ledger-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

const V02_LEDGER =
  "---\ntype: Task Ledger\ntitle: Todos\n---\n## Todo\n\n- [ ] TASK-001 Existing\n  status: todo\n\n## Doing\n\n## Done\n\n## Deferred\n";

describe("openTaskLedger", () => {
  it("writes a TASK-### into the record's ledger, preserving its frontmatter", async () => {
    await write("forge.json", JSON.stringify({ formatVersion: "0.2", recordRoot: "design" }));
    await write("design/todos.md", V02_LEDGER);

    const ledger = await openTaskLedger(root);
    const id = ledger?.add({ title: "From a meeting", genesis: "meeting 2026-07-18" });
    await ledger?.save();

    expect(ledger?.layout).toBe("v0.2");
    expect(id).toBe("TASK-002");

    const text = await fs.readFile(path.join(root, "design/todos.md"), "utf8");
    const concept = parseConcept("todos.md", text);
    expect(concept.problems).toEqual([]);
    expect(concept.frontmatter.title).toBe("Todos");
    const entry = allEntries(parseTodos(concept.body)).find((e) => e.id === "TASK-002");
    expect(entry?.fields.genesis).toBe("meeting 2026-07-18");
    expect(entry?.fields.status).toBe("todo");
  });

  it("refuses an older layout rather than writing to it (DDR-095)", async () => {
    // Rewriting an unmigrated project is `forge upgrade`'s job, not a side
    // effect of accepting an intake item. Both pre-0.2 shapes read as "no
    // ledger here" so the caller reports nothing rather than writing v0.1.
    await write("Todos.md", "## Todo\n\n- [ ] TASK-001 Existing\n  status: todo\n");
    await write("todo/todo.md", "## Backlog\n\n- [ ] T-001 Existing\n");

    expect(await openTaskLedger(root)).toBeNull();
    expect(await readTaskCounts(root)).toBeNull();
  });

  it("returns null when the repo has no ledger at all", async () => {
    expect(await openTaskLedger(root)).toBeNull();
    expect(await readTaskCounts(root)).toBeNull();
  });
});
