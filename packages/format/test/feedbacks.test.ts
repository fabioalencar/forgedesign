import { describe, expect, it } from "vitest";
import {
  addFeedback,
  feedbackDisposition,
  feedbackSource,
  nextFeedbackId,
  parseFeedbacks,
  serializeFeedbacks,
  setFeedbackDisposition,
} from "../src/feedbacks.js";
import { findEntry } from "../src/ledger.js";

const FIXTURE = `- FEEDBACK-011 — 2026-07-18 · source: meeting · from: STAKEHOLDER-002
  quote: "The enterprise column reads like an afterthought."
  status: accepted → TASK-042
- FEEDBACK-012 — 2026-07-19 · source: review (FREEZE-003) · from: STAKEHOLDER-004
  quote: "Can we hide pricing entirely for logged-out users?"
  status: declined → DDR-051
`;

describe("round-trip", () => {
  it("is byte-identical for well-formed input", () => {
    expect(serializeFeedbacks(parseFeedbacks(FIXTURE))).toBe(FIXTURE);
  });
});

describe("feedbackDisposition / feedbackSource", () => {
  const doc = parseFeedbacks(FIXTURE);

  it("splits the accepted → TASK link", () => {
    const entry = findEntry(doc, "FEEDBACK-011")!.entry;
    expect(feedbackDisposition(entry)).toEqual({ status: "accepted", link: "TASK-042" });
    expect(feedbackSource(entry)).toBe("meeting");
  });

  it("splits the declined → DDR link", () => {
    const entry = findEntry(doc, "FEEDBACK-012")!.entry;
    expect(feedbackDisposition(entry)).toEqual({ status: "declined", link: "DDR-051" });
  });

  it("extracts the source keyword even with a parenthetical suffix", () => {
    const entry = findEntry(doc, "FEEDBACK-012")!.entry;
    expect(feedbackSource(entry)).toBe("review");
  });
});

describe("nextFeedbackId / addFeedback", () => {
  it("allocates the next id and appends a well-formed entry", () => {
    const doc = parseFeedbacks(FIXTURE);
    const id = nextFeedbackId(doc);
    expect(id).toBe("FEEDBACK-013");

    addFeedback(doc, {
      id,
      date: "2026-07-20",
      source: "chat",
      from: "STAKEHOLDER-005",
      quote: "Looks great",
      status: "pending",
    });

    const serialized = serializeFeedbacks(doc);
    expect(serialized).toContain(
      "FEEDBACK-013 — 2026-07-20 · source: chat · from: STAKEHOLDER-005",
    );
    expect(serialized).toContain("status: pending");
  });

  it("setFeedbackDisposition rewrites only the status line, with and without a link", () => {
    const doc = parseFeedbacks(FIXTURE);
    const entry = findEntry(doc, "FEEDBACK-011")!.entry;
    setFeedbackDisposition(entry, "deferred");
    expect(entry.lines).toContain("  status: deferred");
    expect(feedbackDisposition(entry)).toEqual({ status: "deferred", link: null });

    setFeedbackDisposition(entry, "accepted", "TASK-099");
    expect(entry.lines).toContain("  status: accepted → TASK-099");
    expect(entry.refs).toContain("TASK-099");
    // the quote line above it is untouched
    expect(entry.lines).toContain('  quote: "The enterprise column reads like an afterthought."');
  });

  it("renders sourceDetail as the spec §4 parenthetical, and it round-trips through feedbackSource", () => {
    const doc = parseFeedbacks(FIXTURE);
    addFeedback(doc, {
      id: "FEEDBACK-014",
      date: "2026-07-21",
      source: "review",
      sourceDetail: "FREEZE-004",
      status: "pending",
    });
    const serialized = serializeFeedbacks(doc);
    expect(serialized).toContain("source: review (FREEZE-004)");

    const entry = findEntry(parseFeedbacks(serialized), "FEEDBACK-014")!.entry;
    expect(feedbackSource(entry)).toBe("review");
    expect(entry.refs).toContain("FREEZE-004");
  });
});
