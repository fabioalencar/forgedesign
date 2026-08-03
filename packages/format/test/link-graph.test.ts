import { describe, expect, it } from "vitest";
import { findDuplicateIds, findUnresolvedRefs } from "../src/link-graph.js";

describe("findDuplicateIds", () => {
  it("reports ids used more than once", () => {
    expect(findDuplicateIds(["TASK-001", "TASK-002", "TASK-001"])).toEqual([
      { id: "TASK-001", count: 2 },
    ]);
  });

  it("returns an empty array when every id is unique", () => {
    expect(findDuplicateIds(["TASK-001", "TASK-002"])).toEqual([]);
  });
});

describe("findUnresolvedRefs", () => {
  it("reports refs missing from the known-id set", () => {
    const known = new Set(["TASK-001", "FEEDBACK-011"]);
    expect(findUnresolvedRefs(["TASK-001", "QUESTION-004"], known)).toEqual(["QUESTION-004"]);
  });

  it("deduplicates repeated unresolved refs", () => {
    const known = new Set<string>();
    expect(findUnresolvedRefs(["TASK-001", "TASK-001"], known)).toEqual(["TASK-001"]);
  });

  it("returns an empty array when everything resolves", () => {
    const known = new Set(["TASK-001"]);
    expect(findUnresolvedRefs(["TASK-001"], known)).toEqual([]);
  });
});
