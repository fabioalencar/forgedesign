import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptIntakeItem, applyIntake, intakeWarnings, stageIntake } from "../src/intake.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-intake-"));
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/**
 * A current record (DDR-095) — intake promotes a task through the bundle ledger
 * and there is no longer a v1 one to fall back to.
 *
 * The root `decisions/` below is deliberate and is *not* an oversight: intake's
 * `ddr` and `artifact` branches still write the v1 surfaces, which is the open
 * checkpoint TASK-305 owns. This fixture keeps them exercised exactly as they
 * are rather than settling that question by editing a test.
 */
async function repo(): Promise<string> {
  const root = path.join(sandbox, "repo");
  await fs.mkdir(path.join(root, "design"), { recursive: true });
  await fs.mkdir(path.join(root, "decisions"), { recursive: true });
  await fs.writeFile(
    path.join(root, "forge.json"),
    JSON.stringify({ formatVersion: "0.2", recordRoot: "design" }, null, 2),
  );
  await fs.writeFile(
    path.join(root, "design", "todos.md"),
    "---\ntype: Task Ledger\ntitle: Todos\n---\n## Todo\n\n## Done\n",
  );
  await fs.writeFile(path.join(root, "decisions/DDR-001-existing.md"), "# Existing\n");
  return root;
}

const LEDGER = path.join("design", "todos.md");

describe("context intake", () => {
  it("flags a short, timestamp-less source without blocking staging", async () => {
    expect(intakeWarnings("just a note").map((warning) => warning.code)).toEqual([
      "short",
      "no-timestamps",
    ]);
    const root = await repo();
    const staged = await stageIntake({
      cwd: root,
      sourceName: "meeting notes.md",
      source: "just a note",
    });
    expect(staged.needsConfirmation).toBe(true);
    expect(await fs.readFile(path.join(root, LEDGER), "utf8")).toContain("## Todo");
    await expect(applyIntake({ cwd: root, id: staged.id })).rejects.toThrow("needs confirmation");
  });

  it("validates a skill-written proposal.json, drops unverifiable items, and promotes each item explicitly", async () => {
    const root = await repo();
    const source = [
      "00:00:00.000 --> 00:00:10.000",
      "We need a new checkout flow.",
      "00:00:10.000 --> 00:00:20.000",
      "Decide whether guest checkout is in scope.",
      ...Array.from({ length: 80 }, () => "discussion"),
    ].join(" ");
    const staged = await stageIntake({ cwd: root, sourceName: "meetily-export.vtt", source });
    expect(staged.warnings).toEqual([]);
    // Simulates the intake skill writing proposal.json after classifying the
    // source in the designer's agent session — no model dispatch from the CLI.
    await fs.writeFile(
      path.join(root, ".forge", "intake", staged.id, "proposal.json"),
      JSON.stringify({
        items: [
          {
            type: "task",
            title: "Review the new checkout",
            quote: "We need a new checkout flow.",
            notes: "Raised in product review.",
          },
          {
            type: "ddr",
            title: "Checkout scope",
            quote: "Decide whether guest checkout is in scope.",
          },
          {
            type: "artifact",
            title: "Map checkout journey",
            quote: "We need a new checkout flow.",
            artifactType: "journey-maps",
          },
          {
            type: "task",
            title: "A quote the skill invented",
            quote: "This sentence never appears in the source.",
          },
        ],
      }),
    );

    const result = await applyIntake({ cwd: root, id: staged.id });
    expect(result.count).toBe(3);
    expect(
      (
        JSON.parse(
          await fs.readFile(
            path.join(root, ".forge", "intake", staged.id, "proposal.json"),
            "utf8",
          ),
        ) as { items: unknown[] }
      ).items,
    ).toHaveLength(3);

    // Staging has not mutated the tracked task, decision, or artifact homes.
    expect(await fs.readFile(path.join(root, LEDGER), "utf8")).not.toContain(
      "Review the new checkout",
    );
    await expect(fs.access(path.join(root, "artifacts"))).rejects.toThrow();

    await expect(acceptIntakeItem({ cwd: root, id: staged.id, index: 0 })).resolves.toMatchObject({
      target: `${LEDGER}#TASK-001`,
    });
    await expect(acceptIntakeItem({ cwd: root, id: staged.id, index: 1 })).resolves.toMatchObject({
      target: "decisions/DDR-002-checkout-scope.md",
    });
    await expect(acceptIntakeItem({ cwd: root, id: staged.id, index: 2 })).resolves.toMatchObject({
      target: "artifacts/journey-maps/map-checkout-journey.md",
    });
    expect(await fs.readFile(path.join(root, LEDGER), "utf8")).toContain("context/");
    expect(
      await fs.readFile(path.join(root, "decisions/DDR-002-checkout-scope.md"), "utf8"),
    ).toContain("Status**: proposed");
    expect(
      await fs.readFile(path.join(root, "artifacts/journey-maps/map-checkout-journey.md"), "utf8"),
    ).toContain("Status**: requested");
    expect(await fs.readdir(path.join(root, "context"))).toHaveLength(1);
  });
});
