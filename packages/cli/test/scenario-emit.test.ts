import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createScenarioRuntime, type ScenarioBundle } from "@forgedesign/scenarios";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitScenarioBundle, SCENARIO_BUNDLE_FILE } from "../src/scenario-emit.js";

let root: string;
let outDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-emit-"));
  outDir = path.join(root, "dist");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

async function seed(): Promise<void> {
  await write("forge.json", JSON.stringify({ formatVersion: "0.2", recordRoot: "design" }));
  await write("design/brief.md", "---\ntype: Brief\n---\n");
  await write(
    "design/roles/ROLE-002.md",
    "---\ntype: Role\nid: ROLE-002\ntitle: Manager\npermissions: [orders.view, orders.approve]\n---\n",
  );
  await write(
    "design/scenarios/SCENARIO-001.md",
    [
      "---",
      "type: Scenario",
      "id: SCENARIO-001",
      "title: Manager approving",
      "role: ROLE-002",
      "permissions: [orders.export, -orders.approve]",
      "flags: { newCheckout: true }",
      "routes:",
      '  hidden: ["/admin/**"]',
      "---",
      "## Flow",
      "",
      "- s1 · Open pending orders · /orders",
      "",
    ].join("\n"),
  );
}

const readBundle = async (): Promise<ScenarioBundle> =>
  JSON.parse(await fs.readFile(path.join(outDir, SCENARIO_BUNDLE_FILE), "utf8"));

describe("emitScenarioBundle", () => {
  it("emits resolved scenarios the runtime can answer from", async () => {
    await seed();

    const result = await emitScenarioBundle(root, outDir);
    expect(result.count).toBe(1);
    expect(result.warnings).toEqual([]);

    // The whole point of the emitter: what the record says, the runtime enforces.
    const runtime = createScenarioRuntime(await readBundle(), "SCENARIO-001");
    expect(runtime.can("orders.view")).toBe(true); // from the role
    expect(runtime.can("orders.export")).toBe(true); // added by the scenario
    expect(runtime.can("orders.approve")).toBe(false); // removed by the scenario
    expect(runtime.flag("newCheckout")).toBe(true);
    expect(runtime.resolveRoute("/admin/users")).toBeNull();
    expect(runtime.active?.flow).toEqual([
      { id: "s1", label: "Open pending orders", route: "/orders" },
    ]);
  });

  it("writes nothing when the record has no scenarios", async () => {
    await write("forge.json", JSON.stringify({ formatVersion: "0.2", recordRoot: "design" }));
    await write("design/brief.md", "---\ntype: Brief\n---\n");

    const result = await emitScenarioBundle(root, outDir);

    expect(result).toMatchObject({ path: null, count: 0 });
    await expect(fs.access(path.join(outDir, SCENARIO_BUNDLE_FILE))).rejects.toThrow();
  });

  it("does nothing for a repo with no bundle", async () => {
    expect(await emitScenarioBundle(root, outDir)).toMatchObject({ path: null, count: 0 });
  });

  it("surfaces a scenario's resolution problems as freeze warnings", async () => {
    await seed();
    await write(
      "design/scenarios/SCENARIO-002.md",
      "---\ntype: Scenario\nid: SCENARIO-002\ntitle: Broken\nrole: ROLE-404\n---\n",
    );

    const result = await emitScenarioBundle(root, outDir);

    // A dangling role would otherwise ship as a silently permission-less
    // review, which is the kind of thing a stakeholder notices and nobody can
    // explain.
    expect(result.warnings.join()).toMatch(/SCENARIO-002: role ROLE-404 is not a role/);
  });
});
