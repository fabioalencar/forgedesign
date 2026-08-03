import { describe, expect, it } from "vitest";
import { parseConcept } from "../src/concepts.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import { planMigrationToV02 } from "../src/migrate.js";

const LEGACY = `---
type: scenario
id: scn-4kf29b1c
version: 2
title: Manager approving a pending order
actor: Ana
role: manager
route: /orders?f=pending
dataset: orders-busy-week
viewport: 1280x800
controls:
  global.route: /orders
  billing.overdue: true
declarations: .forge/scenario-decls/scn-4kf29b1c@2.json
---
Reviewing the approval queue when it is busy.

**Expected outcome:** the flagged order is approvable without leaving the list.
`;

describe("migrating saved scenarios into the bundle", () => {
  it("becomes a SCENARIO-### concept that parses clean", () => {
    const plan = planMigrationToV02({ scenarios: [{ slug: "manager-approving", text: LEGACY }] });
    const file = plan.files.find((f) => f.relPath === "design/scenarios/SCENARIO-001.md");

    expect(file).toBeDefined();
    expect(parseConcept("scenarios/SCENARIO-001.md", file?.text ?? "").problems).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("carries the capture fields and keeps the old storage key traceable", () => {
    const plan = planMigrationToV02({ scenarios: [{ slug: "manager-approving", text: LEGACY }] });
    const parsed = parseFrontmatter(
      plan.files.find((f) => f.relPath === "design/scenarios/SCENARIO-001.md")?.text ?? "",
    );
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;

    expect(parsed.data).toMatchObject({
      type: "Scenario",
      id: "SCENARIO-001",
      title: "Manager approving a pending order",
      version: 2,
      actor: "Ana",
      role: "manager",
      route: "/orders?f=pending",
      dataset: "orders-busy-week",
      viewport: "1280x800",
      controls: { "global.route": "/orders", "billing.overdue": "true" },
      // The `scn-` id was a storage key, not a record id — kept so a pin or a
      // declaration snapshot naming it can still be traced back.
      legacy_id: "scn-4kf29b1c",
    });
  });

  it("keeps the purpose and expected outcome in the body", () => {
    const plan = planMigrationToV02({ scenarios: [{ slug: "manager-approving", text: LEGACY }] });
    const text =
      plan.files.find((f) => f.relPath === "design/scenarios/SCENARIO-001.md")?.text ?? "";
    expect(text).toContain("Reviewing the approval queue when it is busy.");
    expect(text).toContain("**Expected outcome:** the flagged order is approvable");
  });

  it("numbers several scenarios in file order and marks the folder superseded", () => {
    const plan = planMigrationToV02({
      scenarios: [
        { slug: "a", text: LEGACY },
        { slug: "b", text: LEGACY },
      ],
    });
    expect(plan.files.map((f) => f.relPath)).toEqual(
      expect.arrayContaining([
        "design/scenarios/SCENARIO-001.md",
        "design/scenarios/SCENARIO-002.md",
      ]),
    );
    expect(plan.supersededSources).toContain("scenarios/");
  });

  it("reports a scenario it cannot read instead of dropping it", () => {
    const plan = planMigrationToV02({ scenarios: [{ slug: "broken", text: "no frontmatter\n" }] });
    expect(plan.warnings.join()).toMatch(/no frontmatter block/);
    expect(plan.files.some((f) => f.relPath.includes("SCENARIO"))).toBe(false);
  });
});
