import { describe, expect, it } from "vitest";
import {
  findIdReferences,
  formatId,
  isReservedPrefix,
  nextId,
  parseId,
  RESERVED_PREFIXES,
} from "../src/ids.js";

describe("parseId / formatId", () => {
  it("round-trips a well-formed id", () => {
    expect(parseId("TASK-042")).toEqual({ prefix: "TASK", number: 42, raw: "TASK-042" });
    expect(formatId("TASK", 42)).toBe("TASK-042");
  });

  it("pads single-digit numbers to three digits", () => {
    expect(formatId("DDR", 5)).toBe("DDR-005");
  });

  it("rejects malformed ids", () => {
    expect(parseId("task-001")).toBeNull();
    expect(parseId("TASK001")).toBeNull();
    expect(parseId("TASK-")).toBeNull();
  });
});

describe("isReservedPrefix", () => {
  it("accepts every reserved prefix", () => {
    for (const prefix of RESERVED_PREFIXES) expect(isReservedPrefix(prefix)).toBe(true);
  });

  it("rejects an unknown prefix", () => {
    expect(isReservedPrefix("WIDGET")).toBe(false);
  });
});

describe("findIdReferences", () => {
  it("finds every bare id token in free text", () => {
    expect(findIdReferences("blocked on QUESTION-004 and FEEDBACK-011, see also DDR-050")).toEqual([
      "QUESTION-004",
      "FEEDBACK-011",
      "DDR-050",
    ]);
  });

  it("returns an empty array when there are none", () => {
    expect(findIdReferences("no ids here")).toEqual([]);
  });

  it("treats an id in an inline code span as a literal, not a reference (DDR-069)", () => {
    // How a record writes *about* the format, or about another record's
    // fixture, without claiming to hold those concepts.
    expect(findIdReferences("ids look like `TASK-001`; DDR-050 is a real one")).toEqual([
      "DDR-050",
    ]);
  });

  it("ignores ids inside a fenced block, whatever the fence encloses", () => {
    const text = [
      "before DDR-050",
      "```yaml",
      "id: FEEDBACK-011",
      "```",
      "after QUESTION-004",
    ].join("\n");
    expect(findIdReferences(text)).toEqual(["DDR-050", "QUESTION-004"]);
  });

  it("does not let a tilde fence be closed by a backtick one", () => {
    const text = ["~~~", "TASK-001", "```", "TASK-002", "~~~", "TASK-003"].join("\n");
    expect(findIdReferences(text)).toEqual(["TASK-003"]);
  });

  it("ignores a standard's name, which only looks like an id (DDR-071)", () => {
    // The bug this closes: writing "UTF-8" in prose made doctor demand a
    // concept named UTF-8. Spec §4 defines an ID by its reserved prefix, so
    // nothing else with the shape is one.
    expect(findIdReferences("read as UTF-8, per ISO-8601, over HTTP-2")).toEqual([]);
  });

  it("ignores a plausible-looking prefix that is not reserved", () => {
    expect(findIdReferences("EPIC-001 and WIDGET-042 are not record ids")).toEqual([]);
    expect(findIdReferences("but TASK-001 is")).toEqual(["TASK-001"]);
  });

  it("still reads every reserved prefix", () => {
    const text = RESERVED_PREFIXES.map((prefix) => `${prefix}-001`).join(" ");
    expect(findIdReferences(text)).toHaveLength(RESERVED_PREFIXES.length);
  });

  it("keeps an id whose backtick never closes — an unpaired tick is not a quote", () => {
    // Failing toward "this is a reference" is the safe direction: doctor
    // reports something a human can dismiss, rather than going quiet.
    expect(findIdReferences("a stray ` and then TASK-007")).toEqual(["TASK-007"]);
  });
});

describe("nextId", () => {
  it("increments the max number for a prefix, ignoring others", () => {
    expect(nextId(["TASK-001", "TASK-014", "DDR-050"], "TASK")).toBe("TASK-015");
  });

  it("starts at 001 when no ids exist for the prefix", () => {
    expect(nextId(["DDR-050"], "TASK")).toBe("TASK-001");
  });
});
