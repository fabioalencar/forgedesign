import { describe, expect, it } from "vitest";
import { parseCalendarRows } from "../src/calendar.js";

describe("parseCalendarRows (spec §5, TASK-460)", () => {
  it("reads the date, the kind before the colon, and the ids a row references", () => {
    const rows = parseCalendarRows(
      [
        "- 2026-08-01 · checkpoint: stakeholder review of FREEZE-004 (STAKEHOLDER-002)",
        "- 2026-08-15 · deadline: dev handoff — gated on DDR-053",
      ].join("\n"),
    );
    expect(rows).toEqual([
      {
        date: "2026-08-01",
        text: "checkpoint: stakeholder review of FREEZE-004 (STAKEHOLDER-002)",
        kind: "checkpoint",
        refs: ["FREEZE-004", "STAKEHOLDER-002"],
      },
      {
        date: "2026-08-15",
        text: "deadline: dev handoff — gated on DDR-053",
        kind: "deadline",
        refs: ["DDR-053"],
      },
    ]);
  });

  it("skips rows without a date instead of guessing one, and reads a row with no kind", () => {
    const rows = parseCalendarRows("- sometime: not dated\n- 2026-09-01 the first freeze\n");
    expect(rows).toEqual([{ date: "2026-09-01", text: "the first freeze", kind: null, refs: [] }]);
  });

  it("does not read a sentence's colon as a kind", () => {
    const [row] = parseCalendarRows("- 2026-09-01 · The plan that was agreed: three screens");
    expect(row?.kind).toBeNull();
  });
});
