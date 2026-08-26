// What a brand-new record starts life containing (TASK-437).
//
// The guard here is the one `add-concept` already has for `forge add` guidance,
// applied to the other surface that writes into somebody else's repository. A
// Forge decision id in scaffolded content is not a citation there — it is a
// dangling reference, and `forge doctor` reports it. That matters more here than
// almost anywhere: `forge init` ends by telling the reader to run `forge doctor`,
// so an id in the brief would mean **every new record fails its first check**,
// on the one command the genesis flow points at.

import { describe, expect, it } from "vitest";
import { coreScaffold } from "../src/scaffold.js";

const scaffold = coreScaffold();

describe("the core scaffold", () => {
  it("cites no Forge id in the brief, which lands in someone else's record", () => {
    // Caught by running `forge init` and then `forge doctor` on the result — the
    // format's own tests all passed, because none of them scaffold a record and
    // then validate it.
    expect(scaffold["design/brief.md"]).not.toMatch(/\b[A-Z]+-\d{3}\b/);
  });

  it("cites no Forge id in the task ledger either", () => {
    expect(scaffold["design/todos.md"]).not.toMatch(/\b[A-Z]+-\d{3}\b/);
  });

  it("gives the review rubric's two vectors a home, empty and commented", () => {
    // Homes, not prose: spec §1 principle 3 — empty templates are rot and agents
    // read rot as truth, so the prompt is an HTML comment that renders as nothing
    // and says nothing untrue if it is left in place.
    const brief = scaffold["design/brief.md"] ?? "";
    expect(brief).toContain("## The friction it removes");
    expect(brief).toContain("## The loop it drives");
    for (const heading of ["## The friction it removes", "## The loop it drives"]) {
      const after = brief.slice(brief.indexOf(heading) + heading.length).trimStart();
      expect(after.startsWith("<!--")).toBe(true);
    }
  });

  it("keeps the DDR template's own id, which is its identity rather than a citation", () => {
    expect(scaffold["design/decisions/DDR-000-template.md"]).toContain("DDR-000");
  });
});
