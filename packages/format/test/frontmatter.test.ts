import { describe, expect, it } from "vitest";
import { parseFrontmatter, setFrontmatterFields, splitFrontmatter } from "../src/frontmatter.js";

describe("splitFrontmatter", () => {
  it("separates a block from its body", () => {
    const split = splitFrontmatter("---\ntype: Feedback\n---\nthe body\n");
    expect(split.raw).toBe("type: Feedback");
    expect(split.body).toBe("the body\n");
    expect(split.unterminated).toBe(false);
  });

  it("reports no block when the file does not open with a fence", () => {
    const split = splitFrontmatter("# A heading\n\n---\n\nnot frontmatter\n");
    expect(split.raw).toBeNull();
    expect(split.unterminated).toBe(false);
  });

  it("flags a fence that is never closed rather than swallowing the file", () => {
    const split = splitFrontmatter("---\ntype: Feedback\n\nbody that never closed the block\n");
    expect(split.raw).toBeNull();
    expect(split.unterminated).toBe(true);
  });

  it("handles an empty block", () => {
    expect(splitFrontmatter("---\n---\nbody\n").raw).toBe("");
  });

  it("tolerates CRLF line endings and a BOM", () => {
    // The block normalizes to LF so scalars don't end up holding a carriage
    // return; the body is left exactly as written.
    const split = splitFrontmatter("﻿---\r\ntype: Brief\r\n---\r\nbody\r\n");
    expect(split.raw).toBe("type: Brief");
    expect(split.body).toBe("body\r\n");
    expect(parseFrontmatter("﻿---\r\ntype: Brief\r\n---\r\nbody\r\n")).toMatchObject({
      kind: "ok",
      data: { type: "Brief" },
    });
  });
});

describe("parseFrontmatter", () => {
  it("returns the mapping", () => {
    const parsed = parseFrontmatter("---\ntype: Feedback\nid: FEEDBACK-011\n---\nbody\n");
    expect(parsed).toMatchObject({ kind: "ok", data: { type: "Feedback", id: "FEEDBACK-011" } });
  });

  it("distinguishes a missing block from an invalid one", () => {
    expect(parseFrontmatter("no frontmatter here\n").kind).toBe("missing");
    // A tab-indented mapping is a YAML error, not merely unsupported syntax:
    // telling these apart is why the package parses real YAML (DDR-061).
    const invalid = parseFrontmatter("---\ntype: Feedback\n\tid: bad\n---\nbody\n");
    expect(invalid.kind).toBe("invalid");
  });

  it("rejects a block that is a sequence rather than a mapping", () => {
    const parsed = parseFrontmatter("---\n- one\n- two\n---\nbody\n");
    expect(parsed).toMatchObject({ kind: "invalid" });
  });

  it("treats an empty block as an empty mapping", () => {
    expect(parseFrontmatter("---\n---\nbody\n")).toMatchObject({ kind: "ok", data: {} });
  });

  it("reports an alias bomb as invalid rather than throwing (TASK-408 finding 5)", () => {
    // maxAliasCount fires at resolution (toJS), not parse — it must come back as
    // an invalid concept the caller can name, not an uncaught throw mid-scan.
    const anchors = ["a: &a [x,x,x,x,x,x,x,x,x]"];
    for (const [cur, prev] of [
      ["b", "a"],
      ["c", "b"],
      ["d", "c"],
      ["e", "d"],
    ]) {
      anchors.push(`${cur}: &${cur} [*${prev},*${prev},*${prev},*${prev},*${prev}]`);
    }
    const bomb = `---\ntype: Decision\n${anchors.join("\n")}\n---\nbody\n`;
    let parsed: ReturnType<typeof parseFrontmatter>;
    expect(() => {
      parsed = parseFrontmatter(bomb);
    }).not.toThrow();
    expect(parsed!.kind).toBe("invalid");
  });

  it("reads the YAML shapes the spec's frontmatter example uses", () => {
    const text = [
      "---",
      "type: Feedback",
      'title: "Pricing: reads as an afterthought"',
      "sources:",
      "  - resource: /design/stakeholders/STAKEHOLDER-002.md",
      "generated: { by: forge-cli/0.2.0, at: 2026-07-18T10:12:00Z }",
      "---",
      "body",
      "",
    ].join("\n");
    const parsed = parseFrontmatter(text);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.data.title).toBe("Pricing: reads as an afterthought");
    expect(parsed.data.sources).toEqual([{ resource: "/design/stakeholders/STAKEHOLDER-002.md" }]);
    expect(parsed.data.generated).toMatchObject({ by: "forge-cli/0.2.0" });
  });
});

describe("setFrontmatterFields", () => {
  it("changes one key and leaves comments, order, and body untouched", () => {
    const text = [
      "---",
      "type: Feedback",
      "# why this one matters",
      "id: FEEDBACK-011",
      "feedback_status: pending",
      "---",
      "> the quote",
      "",
    ].join("\n");

    const next = setFrontmatterFields(text, { feedback_status: "accepted" });

    expect(next).toContain("# why this one matters");
    expect(next).toContain("feedback_status: accepted");
    expect(next).not.toContain("pending");
    expect(next.endsWith("> the quote\n")).toBe(true);
    // key order preserved
    expect(next.indexOf("type:")).toBeLessThan(next.indexOf("id:"));
  });

  it("adds a key that was not there and deletes one set to undefined", () => {
    const text = "---\ntype: Question\nquestion_status: open\n---\nbody\n";
    const next = setFrontmatterFields(text, { resolution: "DDR-047", question_status: undefined });
    expect(next).toContain("resolution: DDR-047");
    expect(next).not.toContain("question_status");
  });

  it("creates a block for a file that has none", () => {
    const next = setFrontmatterFields("just a body\n", { type: "Term" });
    expect(next).toBe("---\ntype: Term\n---\njust a body\n");
  });

  it("refuses to edit unparseable frontmatter rather than discarding it", () => {
    expect(() =>
      setFrontmatterFields("---\ntype: A\n\tbad: 1\n---\nbody\n", { type: "B" }),
    ).toThrow(/cannot edit frontmatter/);
    expect(() => setFrontmatterFields("---\nunclosed: true\n", { type: "B" })).toThrow(
      /never closed/,
    );
  });

  it("round-trips through parse after an edit", () => {
    const text = "---\ntype: Decision\nid: DDR-050\ndecision_status: accepted\n---\n## Decision\n";
    const parsed = parseFrontmatter(setFrontmatterFields(text, { decision_status: "superseded" }));
    expect(parsed).toMatchObject({
      kind: "ok",
      data: { id: "DDR-050", decision_status: "superseded" },
    });
  });
});
