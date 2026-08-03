import { describe, expect, it } from "vitest";
import { findEntry } from "../src/ledger.js";
import {
  addTask,
  buildTaskEntry,
  nextTaskId,
  parseTodos,
  serializeTodos,
  setTaskSection,
  taskView,
} from "../src/todos.js";

const FIXTURE = `## Doing
- [ ] TASK-042 Rebuild the pricing table for the enterprise tier
  status: doing · opened: 2026-07-20
  genesis: FEEDBACK-011
  notes: blocked on QUESTION-004 (legal review of tier names)

## Done
- [x] TASK-041 Ship v1
  status: done · opened: 2026-07-01
`;

describe("round-trip", () => {
  it("is byte-identical for well-formed input", () => {
    expect(serializeTodos(parseTodos(FIXTURE))).toBe(FIXTURE);
  });
});

describe("taskView", () => {
  it("projects known fields with enum validation", () => {
    const doc = parseTodos(FIXTURE);
    const view = taskView(findEntry(doc, "TASK-042")!.entry);
    expect(view).toEqual({
      id: "TASK-042",
      checked: false,
      title: "Rebuild the pricing table for the enterprise tier",
      status: "doing",
      opened: "2026-07-20",
      phase: null,
      genesis: "FEEDBACK-011",
      notes: "blocked on QUESTION-004 (legal review of tier names)",
    });
  });

  it("carries the phase a task belongs to, when the row names one (DDR-068)", () => {
    const entry = buildTaskEntry({
      id: "TASK-001",
      title: "x",
      status: "todo",
      opened: "2026-07-20",
      phase: "Phase 47 — Renderer reconciliation",
    });
    expect(entry.lines[2]).toBe("  phase: Phase 47 — Renderer reconciliation");
    expect(taskView(entry).phase).toBe("Phase 47 — Renderer reconciliation");
  });

  it("rejects an invalid status value", () => {
    const entry = buildTaskEntry({
      id: "TASK-001",
      title: "x",
      status: "todo",
      opened: "2026-07-20",
    });
    entry.fields.status = "not-a-real-status";
    expect(taskView(entry).status).toBeNull();
  });
});

describe("setTaskSection", () => {
  it("moves the task, updates status, and syncs the checkbox in one edit", () => {
    const doc = parseTodos(FIXTURE);
    expect(setTaskSection(doc, "TASK-042", "Done")).toBe(true);

    const serialized = serializeTodos(doc);
    expect(serialized).toContain(
      "- [x] TASK-042 Rebuild the pricing table for the enterprise tier",
    );
    expect(serialized).toContain("  status: done · opened: 2026-07-20");
    // other continuation lines survive verbatim
    expect(serialized).toContain("  genesis: FEEDBACK-011");
    expect(serialized.indexOf("## Done")).toBeLessThan(serialized.indexOf("TASK-042"));
  });

  it("moving out of Done unchecks and restates the status", () => {
    const doc = parseTodos(FIXTURE);
    expect(setTaskSection(doc, "TASK-041", "Doing")).toBe(true);
    const serialized = serializeTodos(doc);
    expect(serialized).toContain("- [ ] TASK-041 Ship v1");
    expect(serialized).toContain("  status: doing · opened: 2026-07-01");
  });

  it("same-section move only restates the field, not the position", () => {
    const doc = parseTodos(FIXTURE);
    const before = serializeTodos(doc);
    expect(setTaskSection(doc, "TASK-042", "Doing")).toBe(true);
    expect(serializeTodos(doc)).toBe(before); // already doing · unchecked — nothing changes
  });

  it("returns false for an unknown id", () => {
    const doc = parseTodos(FIXTURE);
    expect(setTaskSection(doc, "TASK-999", "Done")).toBe(false);
  });
});

describe("nextTaskId / addTask", () => {
  it("allocates the next TASK id and appends in the spec §4 shape", () => {
    const doc = parseTodos(FIXTURE);
    expect(nextTaskId(doc)).toBe("TASK-043");

    addTask(doc, "Doing", {
      id: nextTaskId(doc),
      title: "Follow-up",
      status: "doing",
      opened: "2026-07-21",
      genesis: "DDR-050",
    });

    const serialized = serializeTodos(doc);
    expect(serialized).toContain("- [ ] TASK-043 Follow-up");
    expect(serialized).toContain("  status: doing · opened: 2026-07-21");
    expect(serialized).toContain("  genesis: DDR-050");
  });
});
