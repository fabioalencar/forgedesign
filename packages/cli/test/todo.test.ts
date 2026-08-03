import { describe, expect, it } from "vitest";
import {
  addPhase,
  addTask,
  findSection,
  findTask,
  getField,
  moveTask,
  moveTaskToPhase,
  nextTaskId,
  openCountsBySection,
  parseTodo,
  removeField,
  serializeTodo,
  setChecked,
  setField,
  setTitle,
  tasksInSection,
} from "../src/todo.js";

const FIXTURE = `# Acme backlog

Some intro prose that is not a section.

## Backlog

### Phase 1 — CLI core
- [ ] T-001 Monorepo scaffold: packages, TypeScript, pnpm workspaces
  context: spec/v1-spec.md#1, decisions/DDR-002.md
- [ ] T-014 Build token editor color swatch grid
  model: claude-code
  context: tokens/tokens.json, decisions/DDR-003-no-figma.md
  notes:

### Phase 2 — Freeze pipeline
- [ ] T-005 forge freeze
- [ ] T-002 A task with
  notes: a wrapped note that
    continues on a deeper indented line

## In progress

- [ ] T-004 Todo file parser/writer (round-trip safe)
  context: spec/v1-spec.md#6

## Done

- [x] T-003 forge status across registered projects
- [X] T-006 Uppercase checkbox variant

## Inbox — alpha

- [ ] T-007 Stakeholder comment about the header
  quote: "the header feels heavy"
  route: /settings
`;

describe("round-trip safety", () => {
  it("serialize(parse(text)) is byte-identical for a representative file", () => {
    expect(serializeTodo(parseTodo(FIXTURE))).toBe(FIXTURE);
  });

  it("is byte-identical without a trailing newline", () => {
    const text = FIXTURE.trimEnd();
    expect(serializeTodo(parseTodo(text))).toBe(text);
  });

  it("is byte-identical for odd spacing, tabs, and empty sections", () => {
    const gnarly = `## Backlog\n\n\n- [ ] T-001 spaced   out title  \n\tweird tab continuation\n\n## Empty section\n\n## Done\n- [x] T-002 done\n`;
    expect(serializeTodo(parseTodo(gnarly))).toBe(gnarly);
  });
});

describe("parsing", () => {
  const doc = parseTodo(FIXTURE);

  it("finds sections including Inbox with em dash", () => {
    expect(doc.sections.map((s) => s.heading)).toEqual([
      "Backlog",
      "In progress",
      "Done",
      "Inbox — alpha",
    ]);
  });

  it("extracts ids, checked state, and titles", () => {
    const done = findSection(doc, "Done")!;
    expect(tasksInSection(done).map((t) => [t.id, t.checked])).toEqual([
      ["T-003", true],
      ["T-006", true],
    ]);
    const found = findTask(doc, "T-014")!;
    expect(found.section.heading).toBe("Backlog");
    expect(found.task.title).toBe("Build token editor color swatch grid");
  });

  it("parses fields and keeps deeper continuation lines with the task", () => {
    const t14 = findTask(doc, "T-014")!.task;
    expect(getField(t14, "model")).toBe("claude-code");
    expect(getField(t14, "notes")).toBe("");
    const t2 = findTask(doc, "T-002")!.task;
    expect(t2.lines).toHaveLength(3);
    expect(getField(t2, "notes")).toBe("a wrapped note that");
  });

  it("counts open tasks per section (### subheadings don't break attribution)", () => {
    expect(openCountsBySection(doc)).toEqual([
      { section: "Backlog", open: 4 },
      { section: "In progress", open: 1 },
      { section: "Done", open: 0 },
      { section: "Inbox — alpha", open: 1 },
    ]);
  });

  it("computes the next permanent id across all sections", () => {
    expect(nextTaskId(doc)).toBe("T-015");
  });
});

describe("mutations", () => {
  it("moveTask moves the whole block verbatim and stays parseable", () => {
    const doc = parseTodo(FIXTURE);
    expect(moveTask(doc, "T-014", "In progress")).toBe(true);

    const out = serializeTodo(doc);
    const reparsed = parseTodo(out);
    const moved = findTask(reparsed, "T-014")!;
    expect(moved.section.heading).toBe("In progress");
    expect(getField(moved.task, "model")).toBe("claude-code");
    expect(out).not.toMatch(/\n\n\n/);
    expect(openCountsBySection(reparsed)).toEqual([
      { section: "Backlog", open: 3 },
      { section: "In progress", open: 2 },
      { section: "Done", open: 0 },
      { section: "Inbox — alpha", open: 1 },
    ]);
  });

  it("moveTask creates the target section when missing", () => {
    const doc = parseTodo(FIXTURE);
    moveTask(doc, "T-005", "Parked");
    const reparsed = parseTodo(serializeTodo(doc));
    expect(findTask(reparsed, "T-005")!.section.heading).toBe("Parked");
  });

  it("moveTask returns false for unknown ids and leaves the doc untouched", () => {
    const doc = parseTodo(FIXTURE);
    expect(moveTask(doc, "T-999", "Done")).toBe(false);
    expect(serializeTodo(doc)).toBe(FIXTURE);
  });

  it("addTask appends a well-formed task and creates Inbox sections on demand", () => {
    const doc = parseTodo(FIXTURE);
    addTask(doc, "Inbox — beta", {
      id: nextTaskId(doc),
      title: "Comment from beta review",
      fields: [
        { key: "quote", value: '"too much contrast"' },
        { key: "route", value: "/home" },
      ],
    });

    const out = serializeTodo(doc);
    expect(out).toContain("## Inbox — beta\n\n- [ ] T-015 Comment from beta review\n");
    const reparsed = parseTodo(out);
    expect(getField(findTask(reparsed, "T-015")!.task, "route")).toBe("/home");
  });

  it("addTask puts consecutive tasks adjacent, not blank-separated", () => {
    const doc = parseTodo(FIXTURE);
    addTask(doc, "Inbox — alpha", { id: "T-020", title: "Second comment" });
    expect(serializeTodo(doc)).toContain("  route: /settings\n- [ ] T-020 Second comment\n");
  });

  it("adds a distinct phase heading at the end of Backlog", () => {
    const doc = parseTodo(FIXTURE);
    expect(addPhase(doc, "Backlog", "Dashboard polish")).toBe(true);
    const out = serializeTodo(doc);
    expect(out).toContain("### Phase 2 — Freeze pipeline\n- [ ] T-005 forge freeze");
    expect(out).toContain(
      "- [ ] T-002 A task with\n  notes: a wrapped note that\n    continues on a deeper indented line\n\n### Dashboard polish\n\n## In progress",
    );
    expect(() => addPhase(doc, "Backlog", "dashboard POLISH")).toThrow(/already exists/);
  });

  it("moves a whole task block directly into an existing phase", () => {
    const doc = parseTodo(FIXTURE);
    expect(moveTaskToPhase(doc, "T-014", "Backlog", "Phase 2 — Freeze pipeline")).toBe(true);

    const out = serializeTodo(doc);
    expect(out).toContain(
      "### Phase 2 — Freeze pipeline\n- [ ] T-005 forge freeze\n- [ ] T-002 A task with\n  notes: a wrapped note that\n    continues on a deeper indented line\n- [ ] T-014 Build token editor color swatch grid",
    );
    expect(out).toContain(
      "  model: claude-code\n  context: tokens/tokens.json, decisions/DDR-003-no-figma.md",
    );
    expect(serializeTodo(parseTodo(out))).toBe(out);
  });

  it("leaves the document untouched when moving to a stale phase", () => {
    const doc = parseTodo(FIXTURE);
    expect(moveTaskToPhase(doc, "T-014", "Backlog", "No such phase")).toBe(false);
    expect(serializeTodo(doc)).toBe(FIXTURE);
  });

  it("setChecked flips only the checkbox", () => {
    const doc = parseTodo(FIXTURE);
    const task = findTask(doc, "T-004")!.task;
    setChecked(task, true);
    expect(serializeTodo(doc)).toContain("- [x] T-004 Todo file parser/writer (round-trip safe)");
    expect(serializeTodo(doc)).toContain("  context: spec/v1-spec.md#6");
  });

  it("setTitle rewrites the bullet text, keeping the checkbox and id", () => {
    const doc = parseTodo(FIXTURE);
    const task = findTask(doc, "T-014")!.task;
    setTitle(task, "Build the token editor swatch grid");
    expect(task.lines[0]).toBe("- [ ] T-014 Build the token editor swatch grid");
    // fields below the bullet are untouched
    expect(serializeTodo(doc)).toContain(
      "  context: tokens/tokens.json, decisions/DDR-003-no-figma.md",
    );
  });

  it("setField updates in place and inserts new fields after existing ones", () => {
    const doc = parseTodo(FIXTURE);
    const task = findTask(doc, "T-014")!.task;
    setField(task, "notes", "blocked on DDR question");
    setField(task, "model", "openai-compatible");
    setField(task, "assignee", "fabio");

    const lines = findTask(parseTodo(serializeTodo(doc)), "T-014")!.task.lines;
    expect(lines).toEqual([
      "- [ ] T-014 Build token editor color swatch grid",
      "  model: openai-compatible",
      "  context: tokens/tokens.json, decisions/DDR-003-no-figma.md",
      "  notes: blocked on DDR question",
      "  assignee: fabio",
    ]);
  });

  it("removeField deletes the field and its line, and is a no-op when absent", () => {
    const doc = parseTodo(FIXTURE);
    const task = findTask(doc, "T-014")!.task;
    removeField(task, "model");
    expect(task.fields.some((f) => f.key === "model")).toBe(false);
    expect(task.lines.some((l) => /^\s+model:/.test(l))).toBe(false);
    // context survives, and removing a missing field does nothing
    const before = task.lines.length;
    removeField(task, "nonexistent");
    expect(task.lines.length).toBe(before);
    expect(serializeTodo(doc)).toContain(
      "  context: tokens/tokens.json, decisions/DDR-003-no-figma.md",
    );
  });

  it("mutated documents keep the trailing-newline convention", () => {
    const doc = parseTodo(FIXTURE);
    moveTask(doc, "T-001", "Done");
    expect(serializeTodo(doc).endsWith("\n")).toBe(true);
    expect(serializeTodo(doc).endsWith("\n\n")).toBe(false);
  });
});
