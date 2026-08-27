import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "../src/commands/init.js";
import { runDoctor } from "../src/doctor.js";
import { applyReview, reviewStagePath } from "../src/review.js";

// `forge review apply` — the write side of the `review` skill (DDR-108,
// DDR-112).
//
// What is worth pinning here is the refusals. A scan writes into the record
// without a human reading each finding first, so the ways it could quietly put
// something wrong in there are the tests that earn their keep: a dangling
// scenario id, a half-applied batch, a second run duplicating everything.

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-review-"));
  await initProject(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function stage(findings: unknown): Promise<void> {
  const file = reviewStagePath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ findings }), "utf8");
}

const feedbackFile = async (id: string): Promise<string> =>
  fs.readFile(path.join(root, "design", "feedback", `${id}.md`), "utf8");

describe("applyReview", () => {
  it("says what to do when nothing is staged", async () => {
    await expect(applyReview(root)).rejects.toThrow(/no staged review/);
  });

  it("writes each finding as pending scan feedback, carrying its vector", async () => {
    await stage([
      {
        vector: "utility",
        finding: "The brief names no friction, so nothing here can be judged against a job.",
      },
      {
        vector: "coherence",
        finding: "The primary button uses a raw hex value, not a token.",
        route: "/checkout",
        selector: "button.pay",
      },
    ]);

    const result = await applyReview(root);
    expect(result.ids).toEqual(["FEEDBACK-001", "FEEDBACK-002"]);

    const first = await feedbackFile("FEEDBACK-001");
    expect(first).toContain("type: Feedback");
    expect(first).toContain("source: scan");
    expect(first).toContain("vector: utility");
    // Pending, always: a scan that dispositioned its own findings would be a
    // gate, and the gate is Cloud's (DDR-057, DDR-108).
    expect(first).toContain("feedback_status: pending");
    expect(first).toContain("> The brief names no friction");

    const second = await feedbackFile("FEEDBACK-002");
    expect(second).toContain("vector: coherence");
    expect(second).toContain("route: /checkout");
    expect(second).toContain("selector: button.pay");
  });

  it("leaves a record `forge doctor` still passes", async () => {
    await stage([{ vector: "hierarchy", finding: "Two controls compete for primary on /." }]);
    await applyReview(root);
    const result = await runDoctor(root);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("refuses a vector outside the rubric", async () => {
    await stage([{ vector: "vibes", finding: "It feels off." }]);
    await expect(applyReview(root)).rejects.toThrow(/vector.*must be one of/s);
  });

  it("refuses a finding with no words in it", async () => {
    await stage([{ vector: "utility", finding: "   " }]);
    await expect(applyReview(root)).rejects.toThrow(/"finding" is required/);
  });

  it("refuses a scenario id the record does not have", async () => {
    // The failure this prevents is a dangling reference in a file the skill
    // wrote and no human read — `forge doctor` would report it later, and the
    // person reading the report did not put it there.
    await stage([
      {
        vector: "utility",
        finding: "The expected outcome is never reached.",
        scenario: "SCENARIO-404",
      },
    ]);
    await expect(applyReview(root)).rejects.toThrow(/SCENARIO-404.*does not exist/);
  });

  it("refuses a step that names no scenario", async () => {
    await stage([{ vector: "utility", finding: "Step two dead-ends.", step: "s2" }]);
    await expect(applyReview(root)).rejects.toThrow(/"step" needs the "scenario"/);
  });

  it("writes nothing at all when one finding in the batch is bad", async () => {
    // Half a review in the record is worse than none: the only way to tell
    // which half landed is to read it.
    await stage([
      { vector: "utility", finding: "This one is fine." },
      { vector: "nonsense", finding: "This one is not." },
    ]);
    await expect(applyReview(root)).rejects.toThrow(/vector/);
    await expect(fs.readdir(path.join(root, "design", "feedback"))).rejects.toThrow();
  });

  it("consumes the staged file, so a second run cannot double-file the same review", async () => {
    await stage([{ vector: "viability", finding: "The primary action does not serve the loop." }]);
    await applyReview(root);
    await expect(fs.access(reviewStagePath(root))).rejects.toThrow();
    await expect(applyReview(root)).rejects.toThrow(/no staged review/);
  });

  it("keeps allocating past the ids already in the record", async () => {
    await stage([{ vector: "utility", finding: "First." }]);
    await applyReview(root);
    await stage([{ vector: "utility", finding: "Second." }]);
    const second = await applyReview(root);
    expect(second.ids).toEqual(["FEEDBACK-002"]);
  });

  it("derives a one-line title from the finding, and lets one be given", async () => {
    await stage([
      { vector: "coherence", finding: "A finding\nspanning\nlines." },
      { vector: "coherence", finding: "Long body here.", title: "Short title" },
    ]);
    await applyReview(root);
    expect(await feedbackFile("FEEDBACK-001")).toContain("title: A finding spanning lines.");
    expect(await feedbackFile("FEEDBACK-002")).toContain("title: Short title");
  });
});
