import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConcept } from "@forgedesign/format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "../src/commands/init.js";
import { runDoctor } from "../src/doctor.js";
import { createDraftScenario, listSavedScenarios, saveScenario } from "../src/scenarios.js";

let sandbox: string;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-scn-"));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");
});

afterEach(async () => {
  if (previousForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousForgeHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function draftIn(root: string, title: string): Promise<string> {
  const draft = await createDraftScenario({
    cwd: root,
    title,
    purpose: "Reviewing the approval queue when it is busy.",
    expectedOutcome: "the flagged order is approvable without leaving the list",
    actor: "Ana",
    role: "manager",
    route: "/orders?f=pending",
    viewport: "1280x800",
    controls: { "billing.overdue": true },
  });
  return draft.id;
}

describe("saving a scenario into a v0.2 record", () => {
  it("writes a SCENARIO-### concept that doctor accepts", async () => {
    const root = path.join(sandbox, "demo");
    await initProject(root);

    const saved = await saveScenario(await draftIn(root, "Manager approving"), [], root);

    expect(saved.slug).toBe("SCENARIO-001");
    expect(saved.path).toBe(path.join("design", "scenarios", "SCENARIO-001.md"));

    const text = await fs.readFile(path.join(root, saved.path), "utf8");
    const concept = parseConcept("scenarios/SCENARIO-001.md", text);
    expect(concept.problems).toEqual([]);
    expect(concept.frontmatter).toMatchObject({
      type: "Scenario",
      id: "SCENARIO-001",
      title: "Manager approving",
      actor: "Ana",
      role: "manager",
    });

    // The record stays valid, including the index the new concept belongs in.
    expect(await runDoctor(root)).toMatchObject({ findings: [], exitCode: 0 });
  });

  it("allocates ids across the concepts already in the bundle", async () => {
    const root = path.join(sandbox, "demo2");
    await initProject(root);

    await saveScenario(await draftIn(root, "First"), [], root);
    const second = await saveScenario(await draftIn(root, "Second"), [], root);

    expect(second.slug).toBe("SCENARIO-002");
    const listed = await listSavedScenarios(root);
    expect(listed.map((s) => s.frontmatter.id)).toEqual(["SCENARIO-001", "SCENARIO-002"]);
    expect(listed.map((s) => s.frontmatter.title)).toEqual(["First", "Second"]);
  });

  it("keeps a repo with no bundle on the legacy scenarios/<slug>.md path", async () => {
    const root = path.join(sandbox, "legacy");
    await fs.mkdir(root, { recursive: true });

    const saved = await saveScenario(await draftIn(root, "Manager approving"), [], root);

    expect(saved.slug).toBe("manager-approving");
    expect(saved.path).toBe(path.join("scenarios", "manager-approving.md"));
    expect(await fs.readFile(path.join(root, saved.path), "utf8")).toContain("type: scenario");
  });
});
