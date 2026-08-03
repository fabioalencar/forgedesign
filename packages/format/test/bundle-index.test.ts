import { describe, expect, it } from "vitest";
import { buildBundleIndex, INDEX_MARKER, isGeneratedIndex } from "../src/bundle-index.js";
import { parseConcept } from "../src/concepts.js";

const concept = (relPath: string, frontmatter: string, body = "") =>
  parseConcept(relPath, `---\n${frontmatter}\n---\n${body}`);

describe("buildBundleIndex", () => {
  it("declares the OKF version and carries its marker in the body, not frontmatter", () => {
    const text = buildBundleIndex([concept("brief.md", "type: Brief\ntitle: Brief")]);

    // OKF permits only okf_version in an index's frontmatter (§12), so the
    // "this is derived" marker has to live below the fence.
    expect(text.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true);
    expect(text.split("---\n")[2]?.startsWith(INDEX_MARKER)).toBe(true);
    expect(isGeneratedIndex(text)).toBe(true);
  });

  it("groups concepts by directory, bundle root first", () => {
    const text = buildBundleIndex([
      concept(
        "decisions/DDR-001-x.md",
        "type: Decision\nid: DDR-001\ntitle: A call\ndecision_status: accepted",
      ),
      concept("brief.md", "type: Brief\ntitle: Brief"),
      concept("glossary/path.md", "type: Term\ntitle: Path"),
    ]);

    const sections = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(sections).toEqual(["Documents", "decisions", "glossary"]);
    expect(text).toContain("* [Brief](brief.md)");
    expect(text).toContain("* [A call](decisions/DDR-001-x.md)");
  });

  it("prefers a concept's description, falling back to type and id", () => {
    const withDescription = buildBundleIndex([
      concept("brief.md", "type: Brief\ntitle: Brief\ndescription: What we are building"),
    ]);
    expect(withDescription).toContain("* [Brief](brief.md) - What we are building");

    const without = buildBundleIndex([
      concept(
        "questions/QUESTION-001.md",
        "type: Question\nid: QUESTION-001\ntitle: Why?\nquestion_status: open",
      ),
    ]);
    expect(without).toContain("- Question · QUESTION-001");
  });

  it("is deterministic, which is what lets doctor detect staleness by comparing", () => {
    const concepts = [
      concept("brief.md", "type: Brief\ntitle: Brief"),
      concept("glossary/path.md", "type: Term\ntitle: Path"),
    ];
    expect(buildBundleIndex(concepts)).toBe(buildBundleIndex([...concepts].reverse()));
  });

  it("renders an empty bundle without inventing sections", () => {
    const text = buildBundleIndex([]);
    expect(text).toContain("# The record");
    expect([...text.matchAll(/^## /gm)]).toHaveLength(0);
  });
});

describe("isGeneratedIndex", () => {
  it("is false for a hand-written index, so a writer knows to leave it alone", () => {
    expect(isGeneratedIndex('---\nokf_version: "0.2"\n---\n# My own index\n')).toBe(false);
    expect(isGeneratedIndex("# no frontmatter at all\n")).toBe(false);
  });
});
