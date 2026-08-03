import { describe, expect, it } from "vitest";
import { findEntry } from "../src/ledger.js";
import {
  addQuestion,
  nextQuestionId,
  parseQuestions,
  questionResolution,
  serializeQuestions,
} from "../src/questions.js";

const FIXTURE = `- QUESTION-004 — 2026-07-19 · status: open
  Can tier names change without legal review?
  context: Brief.md, FEEDBACK-011
- QUESTION-002 — 2026-07-12 · status: resolved → DDR-047
`;

describe("round-trip", () => {
  it("is byte-identical for well-formed input", () => {
    expect(serializeQuestions(parseQuestions(FIXTURE))).toBe(FIXTURE);
  });
});

describe("parsing", () => {
  const doc = parseQuestions(FIXTURE);

  it("captures the bare question text as body", () => {
    const entry = findEntry(doc, "QUESTION-004")!.entry;
    expect(entry.fields.body).toBe("Can tier names change without legal review?");
    expect(entry.fields.context).toBe("Brief.md, FEEDBACK-011");
  });

  it("resolves status with no link", () => {
    expect(questionResolution(findEntry(doc, "QUESTION-004")!.entry)).toEqual({
      status: "open",
      link: null,
    });
  });

  it("resolves status with a DDR link", () => {
    expect(questionResolution(findEntry(doc, "QUESTION-002")!.entry)).toEqual({
      status: "resolved",
      link: "DDR-047",
    });
  });
});

describe("nextQuestionId / addQuestion", () => {
  it("allocates the next id and appends a well-formed entry", () => {
    const doc = parseQuestions(FIXTURE);
    const id = nextQuestionId(doc);
    expect(id).toBe("QUESTION-005");

    addQuestion(doc, {
      id,
      date: "2026-07-21",
      question: "Should we support SSO on day one?",
      status: "open",
      context: "Brief.md",
    });

    const serialized = serializeQuestions(doc);
    expect(serialized).toContain("QUESTION-005 — 2026-07-21 · status: open");
    expect(serialized).toContain("Should we support SSO on day one?");
  });
});
