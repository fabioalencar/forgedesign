import { describe, expect, it } from "vitest";
import { parseDdrFilename, parseDecision } from "../src/decisions.js";

const ACCEPTED = `# DDR-050 — Pivot: Forge is the design record, not the build tool

- **Status**: accepted
- **Date**: 2026-07-23
- **Context source**: 2026-07-23 strategy session

## Decision

Forge no longer orchestrates AI builds.

## Why

Reasons.
`;

const SUPERSEDED = `# DDR-019 — Model roles

- **Status**: superseded (by DDR-050)
- **Date**: 2026-05-01
- **Context source**: earlier session

## Decision

Roles.
`;

describe("parseDdrFilename", () => {
  it("extracts id and slug from a well-formed filename", () => {
    expect(parseDdrFilename("DDR-050-pivot-design-record.md")).toEqual({
      id: "DDR-050",
      slug: "pivot-design-record",
    });
  });

  it("returns null for a non-DDR filename", () => {
    expect(parseDdrFilename("README.md")).toBeNull();
  });
});

describe("parseDecision", () => {
  it("extracts id, title, status, date, and context source", () => {
    const doc = parseDecision(ACCEPTED);
    expect(doc.id).toBe("DDR-050");
    expect(doc.title).toBe("Pivot: Forge is the design record, not the build tool");
    expect(doc.statusRaw).toBe("accepted");
    expect(doc.status).toEqual({ base: "accepted", supersededBy: null, qualifier: null });
    expect(doc.date).toBe("2026-07-23");
    expect(doc.contextSource).toBe("2026-07-23 strategy session");
  });

  it("parses a superseded status with its link", () => {
    const doc = parseDecision(SUPERSEDED);
    expect(doc.status).toEqual({
      base: "superseded",
      supersededBy: "DDR-050",
      qualifier: null,
    });
    expect(doc.refs).toContain("DDR-050");
  });

  it("reads the enum out of a qualified status, and keeps the qualifier", () => {
    // Authors write the nuance next to the word. Reading only the bare enum
    // demoted these to draft during migration — an accepted decision quietly
    // losing its acceptance.
    const doc = parseDecision(
      ACCEPTED.replace(
        "- **Status**: accepted",
        "- **Status**: accepted · refines DDR-055 with the details its rewrite deferred",
      ),
    );
    expect(doc.status).toEqual({
      base: "accepted",
      supersededBy: null,
      qualifier: "refines DDR-055 with the details its rewrite deferred",
    });
  });

  it("reads an em-dash qualifier, including one whose prose mentions supersession", () => {
    const doc = parseDecision(
      ACCEPTED.replace(
        "- **Status**: accepted",
        "- **Status**: accepted — the styling clause is superseded by DDR-018; the rest holds",
      ),
    );
    expect(doc.status?.base).toBe("accepted");
    expect(doc.status?.supersededBy).toBeNull();
  });

  it("still refuses a status that is not one of the enum values", () => {
    const doc = parseDecision(ACCEPTED.replace("accepted", "mostly-agreed · we think"));
    expect(doc.status).toBeNull();
  });

  it("keeps the raw text for immutability diffing", () => {
    const doc = parseDecision(ACCEPTED);
    expect(doc.raw).toBe(ACCEPTED);
  });
});
