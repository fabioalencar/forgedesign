import { describe, expect, it } from "vitest";
import { splitMermaid } from "../src/mermaid.js";

describe("splitMermaid (DDR-056, TASK-460)", () => {
  it("separates a diagram from the prose around it", () => {
    expect(
      splitMermaid("Before the chart.\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nAfter it."),
    ).toEqual({
      diagrams: ["flowchart TD\n  A --> B"],
      prose: "Before the chart.\n\n\nAfter it.",
    });
  });

  it("keeps every diagram, since a flow may have a happy path and a failure branch", () => {
    const { diagrams } = splitMermaid(
      "```mermaid\nflowchart TD\n  A --> B\n```\n\n```mermaid\nflowchart TD\n  A --> C\n```",
    );
    expect(diagrams).toEqual(["flowchart TD\n  A --> B", "flowchart TD\n  A --> C"]);
  });

  it("keeps an unterminated fence rather than losing it to three missing characters", () => {
    expect(splitMermaid("```mermaid\nflowchart TD\n  A --> B").diagrams).toEqual([
      "flowchart TD\n  A --> B",
    ]);
  });

  it("returns prose untouched when there is no diagram", () => {
    expect(splitMermaid("Just words.")).toEqual({ diagrams: [], prose: "Just words." });
  });

  it("leaves other fences in the prose — only mermaid is a diagram", () => {
    const { diagrams, prose } = splitMermaid("```json\n{ }\n```");
    expect(diagrams).toEqual([]);
    expect(prose).toBe("```json\n{ }\n```");
  });
});
