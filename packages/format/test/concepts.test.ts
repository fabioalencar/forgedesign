import { describe, expect, it } from "vitest";
import {
  audienceOf,
  conceptIdFromPath,
  decisionReach,
  isDerived,
  parseConcept,
  trustTier,
} from "../src/concepts.js";

const problemKinds = (relPath: string, text: string): string[] =>
  parseConcept(relPath, text).problems.map((problem) => problem.kind);

describe("parseConcept", () => {
  it("reads a well-formed feedback concept", () => {
    const text = [
      "---",
      "type: Feedback",
      "id: FEEDBACK-011",
      "title: The enterprise column reads like an afterthought",
      "date: 2026-07-18",
      "feedback_status: accepted",
      "resolution: TASK-042",
      "---",
      "> The enterprise column reads like an afterthought.",
      "",
    ].join("\n");

    const concept = parseConcept("feedback/FEEDBACK-011.md", text);

    expect(concept.problems).toEqual([]);
    expect(concept.type).toBe("Feedback");
    expect(concept.id).toBe("FEEDBACK-011");
    expect(concept.conceptId).toBe("feedback/FEEDBACK-011");
    expect(concept.date).toBe("2026-07-18");
    expect(concept.domainStatus).toEqual({ field: "feedback_status", value: "accepted" });
    expect(concept.status).toBe("stable");
    expect(concept.body.trim()).toBe("> The enterprise column reads like an afterthought.");
    expect(concept.refs).toContain("TASK-042");
  });

  it("never throws on a malformed file — it reports problems", () => {
    expect(problemKinds("feedback/FEEDBACK-011.md", "no frontmatter\n")).toContain(
      "frontmatter-missing",
    );
    expect(problemKinds("feedback/FEEDBACK-011.md", "---\ntitle: no type\n---\n")).toContain(
      "type-missing",
    );
    expect(problemKinds("feedback/FEEDBACK-011.md", "---\ntype: Nonsense\n---\n")).toContain(
      "type-unknown",
    );
  });

  it("requires an id on ID-bearing types and matches it to the filename", () => {
    expect(
      problemKinds(
        "feedback/FEEDBACK-011.md",
        "---\ntype: Feedback\nfeedback_status: pending\n---\n",
      ),
    ).toContain("id-missing");
    expect(
      problemKinds(
        "feedback/FEEDBACK-011.md",
        "---\ntype: Feedback\nid: TASK-011\nfeedback_status: pending\n---\n",
      ),
    ).toContain("id-malformed");
    expect(
      problemKinds(
        "feedback/FEEDBACK-012.md",
        "---\ntype: Feedback\nid: FEEDBACK-011\nfeedback_status: pending\n---\n",
      ),
    ).toContain("id-filename-mismatch");
  });

  it("lets a decision filename carry a slug after its id, but nothing else", () => {
    const frontmatter = "---\ntype: Decision\nid: DDR-050\ndecision_status: accepted\n---\n";
    expect(parseConcept("decisions/DDR-050-pivot-design-record.md", frontmatter).problems).toEqual(
      [],
    );
    expect(parseConcept("decisions/DDR-050.md", frontmatter).problems).toEqual([]);
    expect(problemKinds("decisions/pivot.md", frontmatter)).toContain("id-filename-mismatch");
  });

  it("holds each type to its directory", () => {
    const feedback = "---\ntype: Feedback\nid: FEEDBACK-011\nfeedback_status: pending\n---\n";
    expect(problemKinds("questions/FEEDBACK-011.md", feedback)).toContain(
      "type-mismatched-directory",
    );
    expect(problemKinds("brief.md", "---\ntype: Calendar\n---\n")).toContain(
      "type-mismatched-directory",
    );
    expect(parseConcept("brief.md", "---\ntype: Brief\n---\n").problems).toEqual([]);
  });

  it("keeps OKF status and domain status as separate questions (DDR-060)", () => {
    const concept = parseConcept(
      "decisions/DDR-050-slug.md",
      "---\ntype: Decision\nid: DDR-050\nstatus: draft\ndecision_status: accepted\n---\n",
    );
    expect(concept.problems).toEqual([]);
    expect(concept.status).toBe("draft");
    expect(concept.domainStatus).toEqual({ field: "decision_status", value: "accepted" });

    // The OKF enum rejects a Forge value, which is exactly the confusion the
    // two-field split exists to prevent.
    expect(
      problemKinds(
        "decisions/DDR-050-slug.md",
        "---\ntype: Decision\nid: DDR-050\nstatus: accepted\n---\n",
      ),
    ).toEqual(expect.arrayContaining(["status-invalid", "domain-status-invalid"]));
  });

  it("validates domain status values against the type's own enum", () => {
    expect(
      problemKinds(
        "questions/QUESTION-004.md",
        "---\ntype: Question\nid: QUESTION-004\nquestion_status: pending\n---\n",
      ),
    ).toContain("domain-status-invalid");
    expect(
      parseConcept(
        "questions/QUESTION-004.md",
        "---\ntype: Question\nid: QUESTION-004\nquestion_status: open\n---\n",
      ).problems,
    ).toEqual([]);
  });

  it("does not demand a domain status from types that declare none", () => {
    expect(
      parseConcept("glossary/design-record.md", "---\ntype: Term\n---\nA thing.\n").problems,
    ).toEqual([]);
    expect(parseConcept("todos.md", "---\ntype: Task Ledger\n---\n## Todo\n").problems).toEqual([]);
  });

  it("reads a decision's reach and treats absence as project (TASK-457)", () => {
    const decision = (front = "") =>
      parseConcept(
        "decisions/DDR-050-slug.md",
        `---\ntype: Decision\nid: DDR-050\ndecision_status: accepted\n${front}---\n`,
      );
    // Every decision written before the field existed keeps meaning what it meant.
    expect(decision().problems).toEqual([]);
    expect(decisionReach(decision())).toBe("project");

    expect(decision("reach: general\n").problems).toEqual([]);
    expect(decisionReach(decision("reach: general\n"))).toBe("general");

    // A third word is a typo for one of the two, not a new category.
    const typo = decision("reach: everywhere\n");
    expect(typo.problems.map((p) => p.kind)).toEqual(["reach-invalid"]);
    expect(typo.problems[0]?.message).toContain("project | general");
  });

  it("holds a check report to checks/<tag>/, one level down (DDR-127)", () => {
    const check = "---\ntype: Check\ntitle: doctor on v1\n---\n";
    expect(parseConcept("checks/v1/doctor.md", check).problems).toEqual([]);
    expect(problemKinds("checks/doctor.md", check)).toContain("type-mismatched-directory");
    expect(problemKinds("checks/v1/deep/doctor.md", check)).toContain("type-mismatched-directory");
    expect(parseConcept("checks/doctor.md", check).problems[0]?.message).toContain("checks/<tag>/");
  });

  it("answers who may see a concept: the file's word, else the type's default (DDR-128)", () => {
    expect(audienceOf(parseConcept("brief.md", "---\ntype: Brief\n---\n"))).toBe("stakeholders");
    expect(
      audienceOf(parseConcept("flows/FLOW-001.md", "---\ntype: Flow\nid: FLOW-001\n---\n")),
    ).toBe("stakeholders");
    // A decision carries the alternatives it beat, so it stays with the creator until flipped.
    const decision = (front = "") =>
      parseConcept(
        "decisions/DDR-050-slug.md",
        `---\ntype: Decision\nid: DDR-050\ndecision_status: accepted\n${front}---\n`,
      );
    expect(audienceOf(decision())).toBe("owner");
    expect(audienceOf(decision("audience: stakeholders\n"))).toBe("stakeholders");
    expect(decision("audience: stakeholders\n").problems).toEqual([]);
    expect(audienceOf(parseConcept("todos.md", "---\ntype: Task Ledger\n---\n## Todo\n"))).toBe(
      "owner",
    );
    expect(
      audienceOf(
        parseConcept(
          "feedback/FEEDBACK-001.md",
          "---\ntype: Feedback\nid: FEEDBACK-001\nfeedback_status: pending\n---\n",
        ),
      ),
    ).toBe("owner");
    // A type the profile does not know leaks nothing.
    expect(audienceOf(parseConcept("x.md", "---\ntype: Mystery\n---\n"))).toBe("owner");

    const typo = decision("audience: everyone\n");
    expect(typo.problems.map((p) => p.kind)).toEqual(["audience-invalid"]);
    expect(typo.problems[0]?.message).toContain("owner | stakeholders");
  });

  it("leaves `reach` alone on types that are not decisions", () => {
    // The profile preserves keys it does not name; `reach` is only a decision's
    // enum, so a term carrying the word is not a decision with a typo.
    expect(
      parseConcept("glossary/design-record.md", "---\ntype: Term\nreach: far\n---\nA thing.\n")
        .problems,
    ).toEqual([]);
  });

  it("reads an unquoted date as a day, not a timestamp", () => {
    // `date: 2026-07-18` parses to a Date in YAML; the record's dates are days.
    expect(parseConcept("brief.md", "---\ntype: Brief\ndate: 2026-07-18\n---\n").date).toBe(
      "2026-07-18",
    );
  });

  it("preserves frontmatter keys this profile does not name", () => {
    const concept = parseConcept("brief.md", "---\ntype: Brief\ncustom_key: kept\n---\n");
    expect(concept.frontmatter.custom_key).toBe("kept");
    expect(concept.problems).toEqual([]);
  });
});

describe("provenance and trust", () => {
  it("treats the presence of `generated` as what makes a file derived", () => {
    const plain = parseConcept("feature-log.md", "---\ntype: Feature Log\n---\n");
    const derived = parseConcept(
      "feature-log.md",
      "---\ntype: Feature Log\ngenerated: { by: forge-cli/0.2.0, at: 2026-07-27T10:00:00Z }\n---\n",
    );
    expect(isDerived(plain)).toBe(false);
    expect(isDerived(derived)).toBe(true);
    expect(derived.generated).toEqual({ by: "forge-cli/0.2.0", at: "2026-07-27T10:00:00Z" });
  });

  it("reads a bare `verified` mapping as a one-element list, as OKF requires", () => {
    const concept = parseConcept(
      "brief.md",
      "---\ntype: Brief\nverified: { by: human:fabio, at: 2026-07-27T10:00:00Z }\n---\n",
    );
    expect(concept.verified).toHaveLength(1);
    expect(trustTier(concept)).toBe("human-reviewed");
  });

  it("derives trust tiers from who verified", () => {
    expect(trustTier(parseConcept("brief.md", "---\ntype: Brief\n---\n"))).toBe("unverified");
    expect(
      trustTier(
        parseConcept("brief.md", "---\ntype: Brief\nverified:\n  - { by: process:nightly }\n---\n"),
      ),
    ).toBe("machine-confirmed");
  });

  it("keeps only source entries that name a resource", () => {
    const concept = parseConcept(
      "brief.md",
      "---\ntype: Brief\nsources:\n  - resource: /design/calendar.md\n    title: Kickoff\n  - title: no resource\n---\n",
    );
    expect(concept.sources).toEqual([{ resource: "/design/calendar.md", title: "Kickoff" }]);
  });
});

describe("conceptIdFromPath", () => {
  it("is the path with .md removed (OKF §2)", () => {
    expect(conceptIdFromPath("feedback/FEEDBACK-011.md")).toBe("feedback/FEEDBACK-011");
    expect(conceptIdFromPath("brief.md")).toBe("brief");
  });
});
