import { describe, expect, it } from "vitest";
import { parsePageRows } from "../src/pages.js";

describe("parsePageRows (spec §5, DDR-130)", () => {
  it("reads the route, the title before the dash, and the ids that touch the page", () => {
    const { rows, problems } = parsePageRows(
      [
        "- / · Home — FLOW-001, STORY-002",
        "- `/register` · Sign up — FLOW-001, STORY-003, TASK-042",
        "- /forgot-password · Forgot password",
      ].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { route: "/", title: "Home", refs: ["FLOW-001", "STORY-002"], line: 1 },
      {
        route: "/register",
        title: "Sign up",
        refs: ["FLOW-001", "STORY-003", "TASK-042"],
        line: 2,
      },
      { route: "/forgot-password", title: "Forgot password", refs: [], line: 3 },
    ]);
  });

  it("finds ids wherever the row puts them, and keeps a title that has no dash", () => {
    const [row] = parsePageRows("- /checkout · Checkout (FLOW-004 and STORY-009)").rows;
    expect(row?.title).toBe("Checkout (FLOW-004 and STORY-009)");
    expect(row?.refs).toEqual(["FLOW-004", "STORY-009"]);
  });

  it("ignores prose, headings and the starter comment, which are not rows", () => {
    const parsed = parsePageRows(
      "<!-- One row per page -->\n\n## Pages\n\nThe screens as of v3.\n\n- /a · A\n",
    );
    expect(parsed.rows.map((row) => row.route)).toEqual(["/a"]);
    expect(parsed.problems).toEqual([]);
  });

  it("reports a bullet that is not a page row rather than skipping it", () => {
    // A calendar row without a date is skipped; a manifest row that does not
    // parse is a claim about a page that cannot be read, and that is a finding.
    const parsed = parsePageRows("- /a · A\n- just a note\n- /b\n- register · No slash\n");
    expect(parsed.rows.map((row) => row.route)).toEqual(["/a"]);
    expect(parsed.problems.map((problem) => problem.line)).toEqual([2, 3, 4]);
    expect(parsed.problems[0]?.message).toContain("expected `- /route · Title`");
    expect(parsed.problems[2]?.message).toContain("starts with `/`");
  });

  it("keeps the route as written — normalising is the reader's job", () => {
    const [row] = parsePageRows("- /register/ · Sign up").rows;
    expect(row?.route).toBe("/register/");
  });
});
