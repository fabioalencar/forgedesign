import { describe, expect, it } from "vitest";
import { readChange } from "../src/changes.js";
import { audienceOf, parseConcept } from "../src/concepts.js";
import { findIdReferences } from "../src/ids.js";

const entry = (fields: string, body = "What a reader will notice.\n") =>
  `---\ntype: Change\nid: CHANGE-004\ntitle: Sign-in says which field is wrong\ndate: 2026-11-08\n${fields}---\n${body}`;

describe("change entries (DDR-176)", () => {
  it("reads every field and crosses to stakeholders by default", () => {
    const concept = parseConcept(
      "changes/CHANGE-004.md",
      entry(
        [
          "change_status: done",
          "routes: [/sign-in]",
          "requested_by: Julia (Acme)",
          "links: [https://linear.app/acme/issue/ACM-42]",
          "refs: [TASK-042, FEEDBACK-011]",
          "",
        ].join("\n"),
      ),
    );
    expect(concept.problems).toEqual([]);
    expect(concept.domainStatus).toEqual({ field: "change_status", value: "done" });
    expect(audienceOf(concept)).toBe("stakeholders");

    const { change, problems } = readChange(concept);
    expect(problems).toEqual([]);
    expect(change).toEqual({
      id: "CHANGE-004",
      title: "Sign-in says which field is wrong",
      status: "done",
      routes: ["/sign-in"],
      requestedBy: "Julia (Acme)",
      links: ["https://linear.app/acme/issue/ACM-42"],
      refs: ["TASK-042", "FEEDBACK-011"],
    });
  });

  it("flips to the owner when the file says so", () => {
    const concept = parseConcept(
      "changes/CHANGE-004.md",
      entry("change_status: exploring\naudience: owner\n"),
    );
    expect(audienceOf(concept)).toBe("owner");
  });

  it("requires a change_status from the enum, and lives in changes/ under its id", () => {
    expect(parseConcept("changes/CHANGE-004.md", entry("")).problems.map((p) => p.kind)).toContain(
      "domain-status-invalid",
    );
    expect(
      parseConcept("changes/CHANGE-004.md", entry("change_status: shipped\n")).problems[0]?.message,
    ).toContain("coming | exploring | done");
    expect(
      parseConcept("feedback/CHANGE-004.md", entry("change_status: done\n")).problems.map(
        (p) => p.kind,
      ),
    ).toContain("type-mismatched-directory");
    expect(
      parseConcept("changes/CHANGE-005.md", entry("change_status: done\n")).problems.map(
        (p) => p.kind,
      ),
    ).toContain("id-filename-mismatch");
  });

  it("reports a relative route, a link that is not a URL and a ref that is not an id", () => {
    const concept = parseConcept(
      "changes/CHANGE-004.md",
      entry(
        "change_status: done\nroutes: [sign-in]\nlinks: [linear ACM-42]\nrefs: [the login task]\nrequested_by: [Julia]\n",
      ),
    );
    const { change, problems } = readChange(concept);
    expect(problems.map((problem) => problem.field)).toEqual([
      "routes",
      "links",
      "refs",
      "requested_by",
    ]);
    expect(change.requestedBy).toBeNull();
  });

  it("makes CHANGE-### a reference anywhere in the record", () => {
    expect(findIdReferences("Shipped as CHANGE-004, see TASK-042.")).toEqual([
      "CHANGE-004",
      "TASK-042",
    ]);
  });
});
