import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDdr } from "../src/ddr.js";
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
 * and a decision through `forge ddr apply` (TASK-305), so this needs nothing
 * outside the bundle.
 */
async function repo(): Promise<string> {
  const root = path.join(sandbox, "repo");
  await fs.mkdir(path.join(root, "design", "decisions"), { recursive: true });
  await fs.writeFile(
    path.join(root, "forge.json"),
    JSON.stringify({ formatVersion: "0.2", recordRoot: "design" }, null, 2),
  );
  await fs.writeFile(
    path.join(root, "design", "todos.md"),
    "---\ntype: Task Ledger\ntitle: Todos\n---\n## Todo\n\n## Done\n",
  );
  return root;
}

const LEDGER = path.join("design", "todos.md");

const SOURCE = [
  "00:00:00.000 --> 00:00:10.000",
  "We need a new checkout flow.",
  "00:00:10.000 --> 00:00:20.000",
  "Decide whether guest checkout is in scope.",
  ...Array.from({ length: 80 }, () => "discussion"),
].join(" ");

/** Stages SOURCE and the proposal a forge-intake skill session would write for it. */
async function stageWithProposal(root: string, items: unknown[]): Promise<string> {
  const staged = await stageIntake({ cwd: root, sourceName: "meetily-export.vtt", source: SOURCE });
  expect(staged.warnings).toEqual([]);
  // Simulates the forge-intake skill writing proposal.json after classifying the
  // source in the designer's agent session — no model dispatch from the CLI.
  await fs.writeFile(
    path.join(root, ".forge", "intake", staged.id, "proposal.json"),
    JSON.stringify({ items }),
  );
  return staged.id;
}

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
    const id = await stageWithProposal(root, [
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
        type: "task",
        title: "A quote the skill invented",
        quote: "This sentence never appears in the source.",
      },
    ]);

    const lines: string[] = [];
    const result = await applyIntake({ cwd: root, id, log: (line) => lines.push(line) });
    expect(result.count).toBe(2);
    expect(lines).toEqual(['dropped an unverifiable item: "A quote the skill invented"']);

    // Staging has not mutated the ledger or the decisions.
    expect(await fs.readFile(path.join(root, LEDGER), "utf8")).not.toContain(
      "Review the new checkout",
    );
    expect(await fs.readdir(path.join(root, "design", "decisions"))).toEqual([]);

    await expect(acceptIntakeItem({ cwd: root, id, index: 0 })).resolves.toMatchObject({
      target: `${LEDGER}#TASK-001`,
    });
    expect(await fs.readFile(path.join(root, LEDGER), "utf8")).toContain("context/");
    expect(await fs.readdir(path.join(root, "context"))).toHaveLength(1);
  });
});

describe("an accepted decision is staged for forge ddr apply (TASK-305)", () => {
  it("stages the title, the quote and the source, and leaves the decision for a person", async () => {
    const root = await repo();
    const id = await stageWithProposal(root, [
      {
        type: "ddr",
        title: "Checkout scope",
        quote: "Decide whether guest checkout is in scope.",
        notes: "Product wants an answer before beta.",
      },
    ]);
    await applyIntake({ cwd: root, id });

    const { target } = await acceptIntakeItem({ cwd: root, id, index: 0 });

    expect(target).toBe(path.join(".forge", "ddr", "checkout-scope.json"));
    // Nothing reaches decisions/ — neither the bundle's nor a root one.
    expect(await fs.readdir(path.join(root, "design", "decisions"))).toEqual([]);
    await expect(fs.access(path.join(root, "decisions"))).rejects.toThrow();
    const staged = JSON.parse(await fs.readFile(path.join(root, target), "utf8"));
    expect(staged).toMatchObject({
      title: "Checkout scope",
      status: "draft",
      decision: "",
      why: "",
      quote: "Decide whether guest checkout is in scope.",
      notes: "Product wants an answer before beta.",
    });
    expect(staged.contextSource).toMatch(/^context\//);

    // `ddr apply` refuses the stub until someone decides, then writes a draft.
    await expect(applyDdr(root, "checkout-scope")).rejects.toThrow(/"decision"/);
    await fs.writeFile(
      path.join(root, target),
      JSON.stringify({ ...staged, decision: "Guest checkout is out.", why: "Fraud risk." }),
    );
    await expect(applyDdr(root, "checkout-scope")).resolves.toEqual({
      id: "DDR-001",
      path: path.join("design", "decisions", "DDR-001-checkout-scope.md"),
    });
  });

  it("stages a second decision with the same title beside the first, never over it", async () => {
    const root = await repo();
    const quote = "Decide whether guest checkout is in scope.";
    const id = await stageWithProposal(root, [
      { type: "ddr", title: "2FA policy", quote },
      { type: "ddr", title: "2FA policy", quote },
    ]);
    await applyIntake({ cwd: root, id });

    const first = await acceptIntakeItem({ cwd: root, id, index: 0 });
    const second = await acceptIntakeItem({ cwd: root, id, index: 1 });

    // A slug `forge ddr apply` accepts starts with a letter.
    expect(first.target).toBe(path.join(".forge", "ddr", "decision-2fa-policy.json"));
    expect(second.target).toBe(path.join(".forge", "ddr", "decision-2fa-policy-2.json"));
  });

  it("drops an artifact request at apply, and refuses one left in an older proposal", async () => {
    const root = await repo();
    const quote = "We need a new checkout flow.";
    const id = await stageWithProposal(root, [
      { type: "artifact", title: "Map checkout journey", quote, artifactType: "journey-maps" },
    ]);

    const lines: string[] = [];
    expect((await applyIntake({ cwd: root, id, log: (line) => lines.push(line) })).count).toBe(0);
    expect(lines[0]).toMatch(/dropped an artifact request: "Map checkout journey"/);

    // A proposal applied before the change still holds one.
    await fs.writeFile(
      path.join(root, ".forge", "intake", id, "proposal.json"),
      JSON.stringify({ items: [{ type: "artifact", title: "Map checkout journey", quote }] }),
    );
    await expect(acceptIntakeItem({ cwd: root, id, index: 0 })).rejects.toThrow(
      /artifact request, which intake no longer files/,
    );
    await expect(fs.access(path.join(root, "artifacts"))).rejects.toThrow();
  });
});
