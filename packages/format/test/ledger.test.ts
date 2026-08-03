import { describe, expect, it } from "vitest";
import {
  allEntries,
  appendEntry,
  appendFlatEntry,
  declaredIds,
  findEntry,
  findSection,
  moveEntry,
  parseLedger,
  referencedIds,
  serializeLedger,
  setEntryChecked,
  setEntryField,
} from "../src/ledger.js";

const CHECKBOX_FIXTURE = `# Todos

Preamble prose.

## Todo
- [ ] TASK-001 Ship the thing
  status: todo · opened: 2026-07-20

## Doing
- [ ] TASK-042 Rebuild the pricing table for the enterprise tier
  status: doing · opened: 2026-07-20
  genesis: FEEDBACK-011
  notes: blocked on QUESTION-004 (legal review of tier names)

## Done
- [x] TASK-003 Ship v1
`;

const FLAT_FIXTURE = `- FEEDBACK-011 — 2026-07-18 · source: meeting · from: STAKEHOLDER-002
  quote: "The enterprise column reads like an afterthought."
  status: accepted → TASK-042
- FEEDBACK-012 — 2026-07-19 · source: review (FREEZE-003) · from: STAKEHOLDER-004
  quote: "Can we hide pricing entirely for logged-out users?"
  status: declined → DDR-051
`;

describe("round-trip safety", () => {
  it("is byte-identical for a sectioned checkbox ledger", () => {
    expect(serializeLedger(parseLedger(CHECKBOX_FIXTURE, { checkbox: true }))).toBe(
      CHECKBOX_FIXTURE,
    );
  });

  it("is byte-identical for a flat (sectionless) ledger", () => {
    expect(serializeLedger(parseLedger(FLAT_FIXTURE, { checkbox: false }))).toBe(FLAT_FIXTURE);
  });

  it("is byte-identical without a trailing newline", () => {
    const text = FLAT_FIXTURE.trimEnd();
    expect(serializeLedger(parseLedger(text, { checkbox: false }))).toBe(text);
  });
});

describe("parsing — sectioned checkbox grammar", () => {
  const doc = parseLedger(CHECKBOX_FIXTURE, { checkbox: true });

  it("finds sections", () => {
    expect(doc.sections.map((s) => s.heading)).toEqual(["Todo", "Doing", "Done"]);
  });

  it("extracts id, checked, title, and combined fields", () => {
    const entry = findEntry(doc, "TASK-042")?.entry;
    expect(entry?.checked).toBe(false);
    expect(entry?.title).toBe("Rebuild the pricing table for the enterprise tier");
    expect(entry?.fields).toEqual({
      status: "doing",
      opened: "2026-07-20",
      genesis: "FEEDBACK-011",
      notes: "blocked on QUESTION-004 (legal review of tier names)",
    });
  });

  it("reads checked state for done entries", () => {
    expect(findEntry(doc, "TASK-003")?.entry.checked).toBe(true);
  });

  it("finds the owning section", () => {
    expect(findEntry(doc, "TASK-001")?.section).toBe(findSection(doc, "Todo"));
  });

  it("lists declared and referenced ids", () => {
    expect(declaredIds(doc)).toEqual(["TASK-001", "TASK-042", "TASK-003"]);
    expect(referencedIds(doc)).toContain("FEEDBACK-011");
    expect(referencedIds(doc)).toContain("QUESTION-004");
  });
});

describe("parsing — flat grammar", () => {
  const doc = parseLedger(FLAT_FIXTURE, { checkbox: false });

  it("has no sections", () => {
    expect(doc.sections).toEqual([]);
  });

  it("extracts every entry from the preamble", () => {
    expect(allEntries(doc).map((e) => e.id)).toEqual(["FEEDBACK-011", "FEEDBACK-012"]);
  });

  it("splits inline dotted fields on the header line", () => {
    const entry = findEntry(doc, "FEEDBACK-011")?.entry;
    expect(entry?.fields.source).toBe("meeting");
    expect(entry?.fields.from).toBe("STAKEHOLDER-002");
  });

  it("captures the header date and keeps it out of the title", () => {
    const entry = findEntry(doc, "FEEDBACK-011")?.entry;
    expect(entry?.date).toBe("2026-07-18");
    expect(entry?.title).toBe("");
  });

  it("captures continuation-line fields including status links", () => {
    const entry = findEntry(doc, "FEEDBACK-011")?.entry;
    expect(entry?.fields.status).toBe("accepted → TASK-042");
    expect(entry?.fields.quote).toBe('"The enterprise column reads like an afterthought."');
  });

  it("keeps parenthetical refs in refs list", () => {
    const entry = findEntry(doc, "FEEDBACK-012")?.entry;
    expect(entry?.refs).toContain("FREEZE-003");
    expect(entry?.refs).toContain("DDR-051");
  });
});

describe("mutation — appendEntry / appendFlatEntry", () => {
  it("appends a new entry to an existing section, keeping prior content intact", () => {
    const doc = parseLedger(CHECKBOX_FIXTURE, { checkbox: true });
    appendEntry(doc, "Todo", {
      id: "TASK-099",
      date: null,
      checked: false,
      title: "New task",
      fields: {},
      refs: ["TASK-099"],
      lines: ["- [ ] TASK-099 New task"],
    });
    const serialized = serializeLedger(doc);
    expect(serialized).toContain("TASK-001 Ship the thing");
    expect(serialized).toContain("TASK-099 New task");
    expect(findEntry(doc, "TASK-099")?.section?.heading).toBe("Todo");
  });

  it("creates a missing section on demand", () => {
    const doc = parseLedger(CHECKBOX_FIXTURE, { checkbox: true });
    appendEntry(doc, "Deferred", {
      id: "TASK-100",
      date: null,
      checked: false,
      title: "Later",
      fields: {},
      refs: ["TASK-100"],
      lines: ["- [ ] TASK-100 Later"],
    });
    expect(findSection(doc, "Deferred")).toBeDefined();
    expect(findEntry(doc, "TASK-100")?.section?.heading).toBe("Deferred");
  });

  it("appends a flat entry after existing ones, separated by a blank line", () => {
    const doc = parseLedger(FLAT_FIXTURE, { checkbox: false });
    appendFlatEntry(doc, {
      id: "FEEDBACK-013",
      date: "2026-07-20",
      checked: null,
      title: "",
      fields: { status: "pending" },
      refs: ["FEEDBACK-013"],
      lines: ["- FEEDBACK-013 — 2026-07-20 · source: chat", "  status: pending"],
    });
    const serialized = serializeLedger(doc);
    expect(serialized).toContain("FEEDBACK-012");
    expect(serialized).toContain("FEEDBACK-013");
    expect(serialized.indexOf("FEEDBACK-012")).toBeLessThan(serialized.indexOf("FEEDBACK-013"));
  });
});

describe("mutation — setEntryField", () => {
  it("replaces only its segment on a composite line, preserving the rest", () => {
    const doc = parseLedger(CHECKBOX_FIXTURE, { checkbox: true });
    const entry = findEntry(doc, "TASK-042")!.entry;
    setEntryField(entry, "status", "done");
    expect(entry.lines).toContain("  status: done · opened: 2026-07-20");
    expect(entry.fields.status).toBe("done");
    expect(entry.fields.opened).toBe("2026-07-20");
    // untouched lines stay byte-identical
    expect(entry.lines).toContain("  genesis: FEEDBACK-011");
  });

  it("replaces a single-field continuation line", () => {
    const doc = parseLedger(FLAT_FIXTURE, { checkbox: false });
    const entry = findEntry(doc, "FEEDBACK-012")!.entry;
    setEntryField(entry, "status", "deferred");
    expect(entry.lines).toContain("  status: deferred");
    expect(entry.fields.status).toBe("deferred");
    expect(entry.refs).not.toContain("DDR-051"); // refs re-derived after the edit
  });

  it("replaces a field living on the header line (OpenQuestions shape)", () => {
    const doc = parseLedger("- QUESTION-002 — 2026-07-12 · status: resolved → DDR-047\n", {
      checkbox: false,
    });
    const entry = findEntry(doc, "QUESTION-002")!.entry;
    setEntryField(entry, "status", "open");
    expect(entry.lines[0]).toBe("- QUESTION-002 — 2026-07-12 · status: open");
    expect(entry.refs).not.toContain("DDR-047");
  });

  it("appends a missing field as a new continuation line after the last field", () => {
    const doc = parseLedger(CHECKBOX_FIXTURE, { checkbox: true });
    const entry = findEntry(doc, "TASK-001")!.entry;
    setEntryField(entry, "genesis", "FEEDBACK-011");
    expect(entry.lines).toEqual([
      "- [ ] TASK-001 Ship the thing",
      "  status: todo · opened: 2026-07-20",
      "  genesis: FEEDBACK-011",
    ]);
    expect(entry.refs).toContain("FEEDBACK-011");
  });

  it("round-trips: the document still serializes with only the edited line changed", () => {
    const doc = parseLedger(CHECKBOX_FIXTURE, { checkbox: true });
    setEntryField(findEntry(doc, "TASK-042")!.entry, "status", "deferred");
    const expected = CHECKBOX_FIXTURE.replace(
      "status: doing · opened: 2026-07-20",
      "status: deferred · opened: 2026-07-20",
    );
    expect(serializeLedger(doc)).toBe(expected);
  });
});

describe("mutation — setEntryChecked / moveEntry", () => {
  it("rewrites only the checkbox marker", () => {
    const doc = parseLedger(CHECKBOX_FIXTURE, { checkbox: true });
    const entry = findEntry(doc, "TASK-042")!.entry;
    setEntryChecked(entry, true);
    expect(entry.lines[0]).toBe("- [x] TASK-042 Rebuild the pricing table for the enterprise tier");
    expect(entry.checked).toBe(true);
  });

  it("is a no-op on plain-bullet entries", () => {
    const doc = parseLedger(FLAT_FIXTURE, { checkbox: false });
    const entry = findEntry(doc, "FEEDBACK-011")!.entry;
    const before = [...entry.lines];
    setEntryChecked(entry, true);
    expect(entry.lines).toEqual(before);
    expect(entry.checked).toBeNull();
  });

  it("moves an entry between sections, collapsing the gap it leaves", () => {
    const doc = parseLedger(CHECKBOX_FIXTURE, { checkbox: true });
    expect(moveEntry(doc, "TASK-042", "Done")).toBe(true);
    expect(findEntry(doc, "TASK-042")?.section?.heading).toBe("Done");
    const serialized = serializeLedger(doc);
    expect(serialized).not.toContain("## Doing\n\n\n"); // no accumulated blank lines
    expect(serialized.indexOf("TASK-003")).toBeLessThan(serialized.indexOf("TASK-042"));
  });

  it("returns false for an unknown id", () => {
    const doc = parseLedger(CHECKBOX_FIXTURE, { checkbox: true });
    expect(moveEntry(doc, "TASK-999", "Done")).toBe(false);
  });
});

describe("identity-style header rows (spec §4: Stakeholders / UserRoles / UserStories)", () => {
  it("reads the identity without the separator that introduces it", () => {
    const doc = parseLedger("- ROLE-001 — Returning customer\n  sees: order history\n", {
      checkbox: false,
    });
    const [entry] = allEntries(doc);

    expect(entry?.id).toBe("ROLE-001");
    expect(entry?.title).toBe("Returning customer");
    expect(entry?.date).toBeNull();
    expect(entry?.fields).toEqual({ sees: "order history" });
  });

  it("still reads a dated header, and round-trips either shape byte-for-byte", () => {
    const text =
      "- ROLE-001 — Returning customer\n  sees: order history\n- FEEDBACK-011 — 2026-07-18 · source: meeting\n";
    const doc = parseLedger(text, { checkbox: false });
    const [role, feedback] = allEntries(doc);

    expect(role?.title).toBe("Returning customer");
    expect(feedback?.date).toBe("2026-07-18");
    expect(feedback?.fields.source).toBe("meeting");
    expect(serializeLedger(doc)).toBe(text);
  });
});
